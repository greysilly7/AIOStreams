import { z } from 'zod';
import { fetch, FormData } from 'undici';
import { Blob } from 'node:buffer';
import {
  appConfig,
  Cache,
  DistributedLock,
  ServiceId,
  Time,
  createLogger,
  fromUrlSafeBase64,
  getSimpleTextHash,
  getTimeTakenSincePoint,
  makeUrlLogSafe,
} from '../utils/index.js';
import { extractInfoHashFromMagnet } from '../parser/utils.js';
import { parseTorrentTitleCached } from '../parser/title.js';
import {
  buildResolveKey,
  hashNzbUrl,
  removeDownloadOnAbort,
  selectFileInTorrentOrNZB,
} from './utils.js';
import {
  DebridDownload,
  DebridError,
  DebridFailureCache,
  DebridFile,
  DebridServiceConfig,
  PlaybackInfo,
  TorrentDebridService,
  UsenetDebridService,
  convertStatusCodeToError,
} from './base.js';
import { Torrent, NZB } from './utils.js';
import { ParsedResult } from '@viren070/parse-torrent-title';

const logger = createLogger('debrid:rsdebrid');

export const RSDebridConfig = z.object({
  url: z
    .string()
    .trim()
    .transform((s) => s.replace(/\/+$/, '')),
  publicUrl: z
    .string()
    .optional()
    .transform((s) => s?.trim().replace(/\/+$/, '')),
  apiKey: z.string().optional(),
  aiostreamsAuth: z.string().optional(),
});

interface RSDebridDownloadRow {
  id: string;
  info_hash?: string | null;
  name?: string | null;
  source_type: string;
  status: string;
}

interface RSDebridCachedFile {
  id: string;
  file_path: string;
  size: number;
  mime_type: string;
}

interface RSDebridDownloadDetail {
  download: RSDebridDownloadRow;
  files: RSDebridCachedFile[];
  last_error?: string | null;
}

function convertRsdebridError(
  message: string,
  statusCode: number,
  statusText: string,
  body?: unknown
): DebridError {
  return new DebridError(message, {
    statusCode,
    statusText,
    code: convertStatusCodeToError(statusCode),
    headers: {},
    body,
    type: 'api_error',
  });
}

function mapRow(row: RSDebridDownloadRow): DebridDownload {
  let status: DebridDownload['status'] = 'queued';
  if (row.status === 'completed') {
    status = 'downloaded';
  } else if (row.status === 'downloading') {
    status = 'downloading';
  }
  return {
    id: row.id,
    hash: row.info_hash ?? undefined,
    name: row.name ?? undefined,
    status,
  };
}

export class RSDebridService
  implements TorrentDebridService, UsenetDebridService
{
  readonly serviceName: ServiceId = 'rsdebrid';
  readonly capabilities = { torrents: true, usenet: true };

  private readonly baseUrl: string;
  private readonly publicUrl: string;
  private readonly apiKey: string | undefined;
  private readonly pollInterval: number;
  private readonly maxWaitTime: number;

  private static playbackLinkCache = Cache.getInstance<
    string,
    string | null
  >('rsdebrid:link');
  private static libraryCache = Cache.getInstance<
    string,
    RSDebridDownloadRow[]
  >('rsdebrid:library');

  constructor(
    private readonly config: DebridServiceConfig,
    options?: { pollInterval?: number; maxWaitTime?: number }
  ) {
    let parsedConfig: z.infer<typeof RSDebridConfig>;
    try {
      parsedConfig = RSDebridConfig.parse(
        JSON.parse(fromUrlSafeBase64(config.token))
      );
    } catch {
      throw new DebridError(
        'Invalid RSDebrid credentials. Expected base64-encoded JSON with a url field and an optional apiKey.',
        {
          statusCode: 400,
          statusText: 'Bad Request',
          code: 'BAD_REQUEST',
          headers: {},
          body: {},
        }
      );
    }

    this.baseUrl = parsedConfig.url.replace(/\/+$/, '');
    this.publicUrl =
      (parsedConfig.publicUrl?.trim().replace(/\/+$/, '') ?? undefined) ||
      this.baseUrl;
    this.apiKey = parsedConfig.apiKey;
    this.pollInterval = options?.pollInterval ?? Time.Second * 10;
    this.maxWaitTime = options?.maxWaitTime ?? Time.Minute * 2;
  }

  private async request<T>(
    method: string,
    path: string,
    options?: { body?: FormData }
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: options?.body,
      });
    } catch (error: any) {
      throw new DebridError(`RSDebrid request failed: ${error.message}`, {
        statusCode: 500,
        statusText: 'Internal Server Error',
        code: 'UNKNOWN',
        headers: {},
        body: null,
        type: 'api_error',
      });
    }

    if (response.status === 204) {
      return undefined as T;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      throw convertRsdebridError(
        typeof (body as any)?.error === 'string'
          ? (body as any).error
          : response.statusText,
        response.status,
        response.statusText,
        body
      );
    }

    return body as T;
  }

  private async fetchBytes(url: string): Promise<Blob> {
    const response = await fetch(url);
    if (!response.ok) {
      throw convertRsdebridError(
        `Failed to fetch ${makeUrlLogSafe(url)}: ${response.status} ${response.statusText}`,
        response.status,
        response.statusText
      );
    }
    const bytes = await response.arrayBuffer();
    return new Blob([bytes]);
  }

  public async addMagnet(magnet: string): Promise<DebridDownload> {
    const form = new FormData();
    form.append('magnet', magnet);
    return this.createDownload('magnet', form);
  }

  /**
   * rsdebrid wants the raw `.torrent` bytes, not a URL, so the file is fetched
   * first and re-uploaded.
   */
  public async addTorrent(torrentUrl: string): Promise<DebridDownload> {
    const bytes = await this.fetchBytes(torrentUrl);
    const form = new FormData();
    form.append('torrent_file', bytes);
    return this.createDownload('torrent_file', form);
  }

  public async addNzb(nzbUrl: string, name: string): Promise<DebridDownload> {
    const bytes = await this.fetchBytes(nzbUrl);
    const form = new FormData();
    form.append(
      'nzb_file',
      bytes,
      name.toLowerCase().endsWith('.nzb') ? name : `${name}.nzb`
    );
    const result = await this.request<{ id?: string }>('POST', '/nzb', {
      body: form,
    });
    if (!result?.id) {
      throw convertRsdebridError(
        'Failed to create rsdebrid NZB download: missing id in response',
        500,
        'Internal Server Error',
        result
      );
    }
    logger.debug(`Created rsdebrid NZB download ${result.id}`, { name });
    return this.getDownload(result.id);
  }

  private async createDownload(
    label: string,
    form: FormData
  ): Promise<DebridDownload> {
    const result = await this.request<{ id?: string }>('POST', '/downloads', {
      body: form,
    });
    if (!result?.id) {
      throw convertRsdebridError(
        'Failed to create rsdebrid download: missing id in response',
        500,
        'Internal Server Error',
        result
      );
    }
    logger.debug(`Created rsdebrid download ${result.id}`, { label });
    return this.getDownload(result.id);
  }

  private async getDownload(id: string): Promise<DebridDownload> {
    const detail = await this.request<RSDebridDownloadDetail>(
      'GET',
      `/downloads/${id}`
    );
    if (!detail?.download) {
      throw convertRsdebridError(
        `Invalid response from /downloads/${id}: missing download object`,
        500,
        'Internal Server Error',
        detail
      );
    }

    const { download, files, last_error } = detail;
    let status: DebridDownload['status'] = 'queued';
    // download.status never transitions to 'failed' in place — last_error is
    // the only failure signal, so it must be checked explicitly.
    if (last_error) {
      status = 'failed';
    } else if (download.status === 'completed') {
      status = 'downloaded';
    } else if (download.status === 'downloading') {
      status = 'downloading';
    }

    const mappedFiles: DebridFile[] = (files ?? []).map((file, index) => ({
      // rsdebrid file ids are UUIDs, but the shared DebridFile.id schema is a
      // number used only for fileIndex matching — the UUID is carried in path
      // and used to build the final stream URL.
      id: index,
      name: file.file_path.split(/[\\/]/).pop() ?? '',
      size: file.size ?? 0,
      mimeType: file.mime_type,
      path: file.id,
    }));

    return {
      id: download.id,
      hash: download.info_hash ?? undefined,
      name: download.name ?? undefined,
      status,
      files: mappedFiles,
    };
  }

  public async removeDownload(id: string): Promise<void> {
    await this.request('DELETE', `/downloads/${id}`);
    logger.debug(`Removed download ${id} from RSDebrid`);
  }

  public async removeMagnet(magnetId: string): Promise<void> {
    return this.removeDownload(magnetId);
  }

  public async removeNzb(nzbId: string): Promise<void> {
    return this.removeDownload(nzbId);
  }

  public async getMagnet(magnetId: string): Promise<DebridDownload> {
    return this.getDownload(magnetId);
  }

  public async getNzb(nzbId: string): Promise<DebridDownload> {
    return this.getDownload(nzbId);
  }

  private libraryCacheKey(): string {
    return `rsdebrid:${getSimpleTextHash(this.config.token)}`;
  }

  private async getCachedRows(): Promise<RSDebridDownloadRow[]> {
    const cacheKey = this.libraryCacheKey();
    const cached = await RSDebridService.libraryCache.get(cacheKey);
    if (cached) {
      const remainingTTL = await RSDebridService.libraryCache.getTTL(cacheKey);
      if (remainingTTL !== null && remainingTTL > 0) {
        const age = appConfig.builtins.debrid.libraryCacheTtl - remainingTTL;
        if (age > appConfig.builtins.debrid.libraryStaleThreshold) {
          logger.debug(
            `Library cache for RSDebrid is stale (age: ${age}s), triggering background refresh`
          );
          this.refreshRowsInBackground(cacheKey).catch((err) =>
            logger.error(`Background library refresh failed for RSDebrid`, err)
          );
        }
        return cached;
      }
    }

    const { result } = await DistributedLock.getInstance().withLock(
      `rsdebrid:library:${cacheKey}`,
      async () => {
        const cached = await RSDebridService.libraryCache.get(cacheKey);
        if (cached) {
          return cached;
        }
        return this.fetchAndCacheRows(cacheKey);
      },
      { type: 'memory', timeout: 10000 }
    );
    return result;
  }

  private async fetchAndCacheRows(cacheKey: string): Promise<RSDebridDownloadRow[]> {
    const start = Date.now();
    const rows = await this.request<RSDebridDownloadRow[]>('GET', '/downloads');
    if (!Array.isArray(rows)) {
      throw convertRsdebridError(
        'Invalid response from RSDebrid. Expected array of downloads',
        500,
        'Internal Server Error',
        rows
      );
    }
    logger.debug(`Listed downloads from RSDebrid`, {
      count: rows.length,
      timeTaken: getTimeTakenSincePoint(start),
    });
    await RSDebridService.libraryCache.set(
      cacheKey,
      rows,
      appConfig.builtins.debrid.libraryCacheTtl,
      true
    );
    return rows;
  }

  private async refreshRowsInBackground(cacheKey: string): Promise<void> {
    const lockKey = `rsdebrid:library:refresh:${cacheKey}`;
    await DistributedLock.getInstance().withLock(
      lockKey,
      async () => {
        await RSDebridService.libraryCache.delete(cacheKey);
        return this.fetchAndCacheRows(cacheKey);
      },
      { type: 'memory', timeout: 1000 }
    );
  }

  public async listDownloads(): Promise<DebridDownload[]> {
    return (await this.getCachedRows()).map(mapRow);
  }

  public async listMagnets(): Promise<DebridDownload[]> {
    const rows = await this.getCachedRows();
    return rows
      .filter((row) => row.source_type === 'torrent')
      .map(mapRow);
  }

  public async listNzbs(): Promise<DebridDownload[]> {
    const rows = await this.getCachedRows();
    return rows.filter((row) => row.source_type === 'nzb').map(mapRow);
  }

  public async checkMagnets(
    magnets: string[],
    sid?: string,
    checkOwned: boolean = true
  ): Promise<DebridDownload[]> {
    if (!checkOwned) {
      return magnets.map(() => ({ id: -1, status: 'queued' as const }));
    }
    const owned = await this.listDownloads();
    return magnets.map((magnet) => {
      const hash = extractInfoHashFromMagnet(magnet);
      const match = hash
        ? owned.find((d) => d.hash?.toLowerCase() === hash)
        : undefined;
      if (match) {
        return {
          ...match,
          status: match.status === 'downloaded' ? 'cached' : match.status,
        };
      }
      return { id: -1, status: 'queued' as const };
    });
  }

  public async checkNzbs(
    nzbs: { name?: string; hash?: string }[],
    checkOwned: boolean = true
  ): Promise<DebridDownload[]> {
    if (!checkOwned) {
      return nzbs.map(() => ({ id: -1, status: 'queued' as const }));
    }
    const owned = await this.listDownloads();
    return nzbs.map(({ hash }) => {
      const match = hash
        ? owned.find((d) => d.hash?.toLowerCase() === hash.toLowerCase())
        : undefined;
      if (match) {
        return {
          ...match,
          status: match.status === 'downloaded' ? 'cached' : match.status,
        };
      }
      return { id: -1, status: 'queued' as const };
    });
  }

  public async generateTorrentLink(
    fileUuid: string,
    clientIp?: string
  ): Promise<string> {
    return `${this.publicUrl}/files/${fileUuid}/download`;
  }

  public async generateUsenetLink(
    downloadId: string,
    fileUuid?: string,
    clientIp?: string
  ): Promise<string> {
    return `${this.publicUrl}/files/${fileUuid}/download`;
  }

  public async resolve(
    playbackInfo: PlaybackInfo,
    filename: string,
    cacheAndPlay: boolean,
    autoRemoveDownloads?: boolean,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const { result } = await DistributedLock.getInstance().withLock(
      buildResolveKey(
        'rsdebrid:lock',
        this.serviceName,
        playbackInfo,
        filename,
        this.config.token,
        this.config.clientIp,
        { cacheAndPlay, autoRemoveDownloads }
      ),
      () =>
        this._resolve(
          playbackInfo,
          filename,
          cacheAndPlay,
          autoRemoveDownloads,
          signal
        ),
      {
        timeout: cacheAndPlay ? this.maxWaitTime + this.pollInterval : 30000,
        ttl: cacheAndPlay
          ? this.maxWaitTime + this.pollInterval + 10000
          : 40000,
      }
    );
    return result;
  }

  private async _resolve(
    playbackInfo: PlaybackInfo,
    filename: string,
    cacheAndPlay: boolean,
    autoRemoveDownloads?: boolean,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const cacheKey = buildResolveKey(
      'rsdebrid:cache',
      this.serviceName,
      playbackInfo,
      filename,
      this.config.token,
      this.config.clientIp
    );
    const cachedLink = await RSDebridService.playbackLinkCache.get(cacheKey);

    if (cachedLink !== undefined) {
      if (cachedLink === null) {
        if (!cacheAndPlay) {
          return undefined;
        }
      } else {
        return cachedLink;
      }
    }

    const failureKey =
      playbackInfo.type === 'torrent'
        ? playbackInfo.hash
        : playbackInfo.nzb
          ? hashNzbUrl(playbackInfo.nzb, false)
          : undefined;
    if (failureKey) {
      await DebridFailureCache.check(
        this.serviceName,
        playbackInfo.type,
        failureKey
      );
    }

    let download: DebridDownload;
    let newlyAdded = false;

    if (playbackInfo.type === 'torrent') {
      const owned = await this.getOwnedByHash(playbackInfo.hash);
      if (owned) {
        download = await this.getDownload(owned.id.toString());
      } else {
        download = await this.addMagnetOrTorrent(playbackInfo, filename);
        newlyAdded = true;
      }
    } else if (playbackInfo.nzb) {
      const owned = playbackInfo.hash
        ? await this.getOwnedByHash(playbackInfo.hash)
        : undefined;
      if (owned) {
        download = await this.getDownload(owned.id.toString());
      } else {
        download = await this.addNzb(playbackInfo.nzb, filename);
        newlyAdded = true;
      }
    } else if (playbackInfo.serviceItemId) {
      download = await this.getNzb(playbackInfo.serviceItemId);
    } else {
      const owned = await this.getOwnedByHash(playbackInfo.hash);
      if (!owned) {
        throw new DebridError(
          'Could not find usenet download in library by hash',
          {
            statusCode: 404,
            statusText: 'Not found',
            code: 'NOT_FOUND',
            headers: {},
            body: { hash: playbackInfo.hash },
            type: 'api_error',
          }
        );
      }
      download = await this.getDownload(owned.id.toString());
    }

    removeDownloadOnAbort(
      signal,
      {
        id: download.id,
        private: playbackInfo.type === 'torrent'
          ? playbackInfo.private
          : undefined,
      },
      (id) => this.removeDownload(id),
      (m) => logger.warn(m)
    );

    if (download.status !== 'downloaded') {
      if (download.status === 'failed') {
        throw this.failDownload(download, playbackInfo.type, failureKey);
      }
      // temporarily cache the null value for 1m
      await RSDebridService.playbackLinkCache.set(cacheKey, null, 60);
      if (!cacheAndPlay) {
        return undefined;
      }

      const maxPolls = Math.ceil(this.maxWaitTime / this.pollInterval);
      for (let i = 0; i < maxPolls; i++) {
        if (signal?.aborted) {
          throw new DebridError('resolve aborted (failover lost)', {
            statusCode: 499,
            statusText: 'Client Closed Request',
            code: 'UNKNOWN',
            headers: {},
            body: null,
            type: 'api_error',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
        // Poll the full download so last_error failures are caught on each
        // iteration rather than after the whole maxWaitTime has elapsed.
        const latest = await this.getDownload(download.id.toString());
        logger.debug(`Polled ${playbackInfo.type} download status`, {
          attempt: i + 1,
          status: latest.status,
        });
        if (latest.status === 'downloaded') {
          download = latest;
          break;
        }
        if (['failed', 'invalid'].includes(latest.status ?? '')) {
          download = latest;
          throw this.failDownload(latest, playbackInfo.type, failureKey);
        }
      }

      if (download.status !== 'downloaded') {
        throw new DebridError(
          `${playbackInfo.type} download timed out waiting for completion (status: ${download.status})`,
          {
            statusCode: 408,
            statusText: 'Timeout',
            code: 'TIMEOUT',
            headers: {},
            body: download,
            type: 'api_error',
          }
        );
      }
    }

    if (!download.files?.length) {
      throw new DebridError(
        `No files found for ${playbackInfo.type} download`,
        {
          statusCode: 400,
          statusText: `No files found for ${playbackInfo.type} download`,
          code: 'NO_MATCHING_FILE',
          headers: {},
          body: download,
          type: 'api_error',
        }
      );
    }

    let file: DebridFile | undefined;
    if (playbackInfo.fileIndex !== undefined) {
      file = download.files[playbackInfo.fileIndex];
    } else if (download.files.length > 1) {
      const allStrings: string[] = [
        download.name ?? '',
        ...download.files.map((file) => file.name ?? ''),
      ];
      const parsedFiles: Map<string, ParsedResult> = new Map(
        allStrings.map((string) => [string, parseTorrentTitleCached(string)])
      );
      const torrentOrNZB: Torrent | NZB =
        playbackInfo.type === 'torrent'
          ? {
              type: 'torrent',
              hash: playbackInfo.hash,
              sources: playbackInfo.sources,
              private: playbackInfo.private,
              title: download.name || filename,
              size: download.size || 0,
            }
          : {
              type: 'usenet',
              nzb: playbackInfo.nzb ?? '',
              hash: playbackInfo.hash,
              title: download.name || filename,
              size: download.size || 0,
            };
      file = await selectFileInTorrentOrNZB(
        torrentOrNZB,
        download,
        parsedFiles,
        playbackInfo.metadata,
        {
          chosenFilename: playbackInfo.filename,
          chosenIndex: playbackInfo.index,
        }
      );
      if (!file) {
        throw new DebridError('No matching file found', {
          statusCode: 400,
          statusText: 'No matching file found',
          code: 'NO_MATCHING_FILE',
          headers: {},
          body: null,
          type: 'api_error',
        });
      }
    } else {
      file = download.files[0];
    }

    if (!file?.path) {
      throw new DebridError('Selected file has no download path', {
        statusCode: 400,
        statusText: 'Selected file has no download path',
        code: 'NO_MATCHING_FILE',
        headers: {},
        body: file,
        type: 'api_error',
      });
    }

    const playbackLink =
      playbackInfo.type === 'torrent'
        ? await this.generateTorrentLink(file.path, this.config.clientIp)
        : await this.generateUsenetLink(
            download.id.toString(),
            file.path,
            this.config.clientIp
          );

    await RSDebridService.playbackLinkCache.set(
      cacheKey,
      playbackLink,
      appConfig.builtins.debrid.instantAvailabilityCacheTtl,
      true
    );

    if (autoRemoveDownloads && newlyAdded && download.id) {
      this.removeDownload(download.id.toString()).catch((err) => {
        logger.warn(
          `Failed to cleanup download ${download.id} after resolve: ${err.message}`
        );
      });
    }

    return playbackLink;
  }

  /**
   * Build a DOWNLOAD_FAILED error for a download whose worker exhausted its
   * retries and surface it through the content-level failure cache so the item
   * is skipped for the configured TTL without re-polling.
   */
  private failDownload(
    download: DebridDownload,
    type: 'torrent' | 'usenet',
    failureKey?: string
  ): DebridError {
    const err = new DebridError(`${type} download ${download.status}`, {
      statusCode: 400,
      statusText: `${type} download ${download.status}`,
      code: 'DOWNLOAD_FAILED',
      headers: {},
      body: download,
      type: 'api_error',
    });
    if (failureKey) {
      DebridFailureCache.mark(this.serviceName, type, failureKey, err).catch(
        () => {}
      );
    }
    return err;
  }

  private async getOwnedByHash(
    hash: string
  ): Promise<DebridDownload | undefined> {
    const owned = await this.listDownloads();
    return owned.find((d) => d.hash?.toLowerCase() === hash.toLowerCase());
  }

  private async addMagnetOrTorrent(
    playbackInfo: PlaybackInfo & { type: 'torrent' },
    filename: string
  ): Promise<DebridDownload> {
    if (playbackInfo.downloadUrl) {
      logger.debug(
        `Adding torrent to rsdebrid: ${makeUrlLogSafe(playbackInfo.downloadUrl)}`
      );
      return this.addTorrent(playbackInfo.downloadUrl);
    }
    let magnet = `magnet:?xt=urn:btih:${playbackInfo.hash}`;
    if (filename) {
      magnet += `&dn=${encodeURIComponent(filename)}`;
    }
    if (playbackInfo.sources?.length) {
      magnet += `&tr=${playbackInfo.sources.join('&tr=')}`;
    }
    return this.addMagnet(magnet);
  }
}