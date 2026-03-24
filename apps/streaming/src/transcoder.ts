/**
 * FFmpeg Transcoder — Spawns FFmpeg child processes to transcode RTMP to HLS.
 *
 * For each active stream, spawns an FFmpeg process that:
 *   - Reads from the RTMP stream URL
 *   - Transcodes to multiple HLS qualities (360p, 720p, 1080p)
 *   - Writes .ts segments + .m3u8 playlists to the output directory
 *
 * The output directory can be a local path (for local/S3 sync) or a
 * mounted volume that's served by a CDN.
 */

import { spawn, ChildProcess } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface TranscodeOptions {
  /** Stream key (used to build RTMP source URL) */
  streamKey: string
  /** RTMP source URL (e.g., rtmp://localhost/live/stream-key) */
  rtmpUrl: string
  /** Output directory for HLS segments and playlists */
  outputDir: string
  /** Enable multi-quality ABR (adaptive bitrate). Default: true */
  abr?: boolean
  /** Enable recording to a separate full-quality file */
  record?: boolean
  /** Recording output path */
  recordPath?: string
}

interface ActiveTranscode {
  process: ChildProcess
  streamKey: string
  startedAt: Date
}

export class Transcoder {
  private active: Map<string, ActiveTranscode> = new Map()
  private ffmpegPath: string

  constructor(ffmpegPath?: string) {
    this.ffmpegPath = ffmpegPath || 'ffmpeg'
  }

  /**
   * Start transcoding an RTMP stream to HLS.
   */
  start(options: TranscodeOptions): void {
    if (this.active.has(options.streamKey)) {
      console.log(`[transcoder] Already transcoding ${options.streamKey}`)
      return
    }

    // Ensure output directory exists
    if (!existsSync(options.outputDir)) {
      mkdirSync(options.outputDir, { recursive: true })
    }

    const args = this.buildFFmpegArgs(options)
    console.log(`[transcoder] Starting FFmpeg for ${options.streamKey}`)

    const proc = spawn(this.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      if (line.includes('error') || line.includes('Error')) {
        console.error(`[transcoder:${options.streamKey}] ${line}`)
      }
    })

    proc.on('exit', (code) => {
      console.log(`[transcoder] FFmpeg exited for ${options.streamKey} (code: ${code})`)
      this.active.delete(options.streamKey)
    })

    this.active.set(options.streamKey, {
      process: proc,
      streamKey: options.streamKey,
      startedAt: new Date(),
    })
  }

  /**
   * Stop transcoding a stream.
   */
  stop(streamKey: string): void {
    const t = this.active.get(streamKey)
    if (t) {
      console.log(`[transcoder] Stopping ${streamKey}`)
      t.process.kill('SIGTERM')
      this.active.delete(streamKey)
    }
  }

  /**
   * Stop all active transcodes.
   */
  stopAll(): void {
    for (const [key] of this.active) {
      this.stop(key)
    }
  }

  /**
   * Check if a stream is currently being transcoded.
   */
  isActive(streamKey: string): boolean {
    return this.active.has(streamKey)
  }

  /**
   * Get all active stream keys.
   */
  getActiveStreams(): string[] {
    return Array.from(this.active.keys())
  }

  /**
   * Build FFmpeg arguments for HLS transcoding.
   *
   * Produces an ABR master playlist with 3 qualities:
   *   - 360p  @ 800kbps
   *   - 720p  @ 2500kbps
   *   - 1080p @ 5000kbps
   */
  private buildFFmpegArgs(options: TranscodeOptions): string[] {
    const masterPlaylist = join(options.outputDir, 'playlist.m3u8')

    if (!options.abr || options.abr === undefined) {
      // Single-quality output (simpler, lower CPU)
      return [
        '-i', options.rtmpUrl,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-b:v', '2500k',
        '-maxrate', '2500k',
        '-bufsize', '5000k',
        '-vf', 'scale=1280:720',
        '-g', '48',
        '-keyint_min', '48',
        '-sc_threshold', '0',
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '10',
        '-hls_flags', 'delete_segments+append_list',
        '-hls_segment_filename', join(options.outputDir, 'seg_%03d.ts'),
        masterPlaylist,
      ]
    }

    // ABR: use filter_complex for multi-quality
    return [
      '-i', options.rtmpUrl,
      '-filter_complex',
      '[0:v]split=3[v360][v720][v1080];' +
      '[v360]scale=640:360[v360out];' +
      '[v720]scale=1280:720[v720out];' +
      '[v1080]scale=1920:1080[v1080out]',

      // 360p stream
      '-map', '[v360out]', '-map', '0:a',
      '-c:v:0', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-b:v:0', '800k', '-maxrate:v:0', '800k', '-bufsize:v:0', '1600k',
      '-c:a:0', 'aac', '-b:a:0', '96k',
      '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',

      // 720p stream
      '-map', '[v720out]', '-map', '0:a',
      '-c:v:1', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-b:v:1', '2500k', '-maxrate:v:1', '2500k', '-bufsize:v:1', '5000k',
      '-c:a:1', 'aac', '-b:a:1', '128k',
      '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',

      // 1080p stream
      '-map', '[v1080out]', '-map', '0:a',
      '-c:v:2', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-b:v:2', '5000k', '-maxrate:v:2', '5000k', '-bufsize:v:2', '10000k',
      '-c:a:2', 'aac', '-b:a:2', '192k',
      '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',

      // HLS output
      '-f', 'hls',
      '-hls_time', '4',
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+append_list+independent_segments',
      '-master_pl_name', 'playlist.m3u8',
      '-hls_segment_filename', join(options.outputDir, 'stream_%v/seg_%03d.ts'),

      // Variant streams
      '-var_stream_map', 'v:0,a:0 v:1,a:1 v:2,a:2',
      join(options.outputDir, 'stream_%v/index.m3u8'),
    ]
  }
}
