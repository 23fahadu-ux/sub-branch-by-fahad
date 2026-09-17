import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';

const RECORDINGS_DIR = path.join(process.cwd(), 'recordings');
const execFileAsync = promisify(execFile);

// Ensure directory exists
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

interface ActiveSession {
  id: string;
  roomId: string;
  episodeTitle?: string;
  cameras: { id: string; label: string }[];
  startedAt: Date;
  chunkFiles: string[];
  totalBytes: number;
  status: 'recording' | 'finalizing' | 'complete' | 'error';
}

const activeSessions = new Map<string, ActiveSession>();

/** Start a new recording session */
export function startSession(opts: {
  roomId: string;
  episodeTitle?: string;
  cameras?: { id: string; label: string }[];
}): ActiveSession {
  const id = uuidv4();
  const sessionDir = path.join(RECORDINGS_DIR, id);
  fs.mkdirSync(sessionDir, { recursive: true });

  const session: ActiveSession = {
    id,
    roomId: opts.roomId,
    episodeTitle: opts.episodeTitle,
    cameras: opts.cameras ?? [],
    startedAt: new Date(),
    chunkFiles: [],
    totalBytes: 0,
    status: 'recording',
  };

  activeSessions.set(id, session);

  // Save metadata
  const metaPath = path.join(sessionDir, 'metadata.json');
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        id,
        roomId: opts.roomId,
        episodeTitle: opts.episodeTitle,
        cameras: opts.cameras,
        startedAt: session.startedAt.toISOString(),
        status: 'recording',
      },
      null,
      2
    )
  );

  console.log(`[RecordingManager] Started session ${id} for room ${opts.roomId}`);
  return session;
}

/** Save a chunk for an active session */
export function saveChunk(sessionId: string, data: Buffer, chunkIndex: number): { bytesWritten: number } {
  const session = activeSessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (session.status !== 'recording') throw new Error(`Session ${sessionId} is not recording`);

  const sessionDir = path.join(RECORDINGS_DIR, sessionId);
  const chunkName = `chunk-${chunkIndex.toString().padStart(5, '0')}.webm`;
  const chunkPath = path.join(sessionDir, chunkName);

  fs.writeFileSync(chunkPath, data);
  session.chunkFiles.push(chunkPath);
  session.totalBytes += data.length;

  return { bytesWritten: data.length };
}

/** Finalize a recording session — concatenate all chunks */
export async function finalizeSession(sessionId: string): Promise<{
  filename: string;
  size: number;
  path: string;
}> {
  const session = activeSessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  session.status = 'finalizing';

  const sessionDir = path.join(RECORDINGS_DIR, sessionId);
  const timestamp = Date.now();
  const outputName = `connecting-dot-${timestamp}-${sessionId.slice(0, 8)}.webm`;
  const outputPath = path.join(RECORDINGS_DIR, outputName);

  // WebM chunks are separate containers; remux them instead of concatenating bytes.
  const listPath = path.join(sessionDir, 'chunks.txt');
  const chunkList = session.chunkFiles
    .filter((chunkPath) => fs.existsSync(chunkPath))
    .map((chunkPath) => `file '${chunkPath.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listPath, chunkList);

  try {
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
      '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0',
      '-c:a', 'libopus', '-b:a', '128k',
      outputPath,
    ]);
  } catch (error) {
    console.warn('[RecordingManager] ffmpeg remux failed; falling back to byte concatenation:', error);
    const writeStream = fs.createWriteStream(outputPath);
    for (const chunkPath of session.chunkFiles) {
      if (fs.existsSync(chunkPath)) writeStream.write(fs.readFileSync(chunkPath));
    }
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      writeStream.end();
    });
  }
  try { fs.unlinkSync(listPath); } catch { /* cleanup is best effort */ }

  const stats = fs.statSync(outputPath);

  // Update metadata
  const metaPath = path.join(sessionDir, 'metadata.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  meta.status = 'complete';
  meta.completedAt = new Date().toISOString();
  meta.outputFile = outputName;
  meta.totalBytes = stats.size;
  meta.durationSeconds = (Date.now() - session.startedAt.getTime()) / 1000;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  session.status = 'complete';

  // Clean up chunks (keep metadata)
  session.chunkFiles.forEach((f) => {
    try {
      fs.unlinkSync(f);
    } catch { /* ok */ }
  });

  console.log(`[RecordingManager] Finalized session ${sessionId}: ${outputName} (${stats.size} bytes)`);

  return {
    filename: outputName,
    size: stats.size,
    path: outputPath,
  };
}

/** Get active session info */
export function getSession(sessionId: string): ActiveSession | undefined {
  return activeSessions.get(sessionId);
}

/** List all active sessions */
export function listActiveSessions(): ActiveSession[] {
  return Array.from(activeSessions.values()).filter((s) => s.status === 'recording');
}

/** Get storage info */
export function getStorageInfo(): {
  totalRecordings: number;
  totalBytes: number;
  recordingsDir: string;
} {
  try {
    const files = fs.readdirSync(RECORDINGS_DIR).filter((f) => {
      if (f.startsWith('.') || f.startsWith('_')) return false;
      const stat = fs.statSync(path.join(RECORDINGS_DIR, f));
      return stat.isFile();
    });

    let totalBytes = 0;
    files.forEach((f) => {
      const stat = fs.statSync(path.join(RECORDINGS_DIR, f));
      totalBytes += stat.size;
    });

    return { totalRecordings: files.length, totalBytes, recordingsDir: RECORDINGS_DIR };
  } catch {
    return { totalRecordings: 0, totalBytes: 0, recordingsDir: RECORDINGS_DIR };
  }
}

/** Delete a recording */
export function deleteRecording(filename: string): boolean {
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return false;
  const filePath = path.join(RECORDINGS_DIR, filename);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

/** Get metadata for a specific recording session */
export function getRecordingMetadata(sessionId: string): Record<string, unknown> | null {
  const metaPath = path.join(RECORDINGS_DIR, sessionId, 'metadata.json');
  if (!fs.existsSync(metaPath)) return null;
  return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
}
