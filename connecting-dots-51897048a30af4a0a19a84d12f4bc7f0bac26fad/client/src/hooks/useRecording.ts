import { useState, useRef, useCallback } from 'react';
import { API_BASE } from '../utils/constants';

interface UseRecordingReturn {
  isRecording: boolean;
  duration: number;
  recordingBlob: Blob | null;
  sessionId: string | null;
  bytesUploaded: number;
  serverSaveEnabled: boolean;
  setServerSaveEnabled: (v: boolean) => void;
  startRecording: (roomId?: string, episodeTitle?: string) => Promise<void>;
  stopRecording: () => Promise<void>;
  downloadRecording: () => void;
}

const useRecording = (canvasRef: React.RefObject<HTMLCanvasElement>): UseRecordingReturn => {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [bytesUploaded, setBytesUploaded] = useState(0);
  const [serverSaveEnabled, setServerSaveEnabled] = useState(true);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunkIndexRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uploadQueueRef = useRef<Promise<void>[]>([]);

  /** Upload a chunk to the server session */
  const uploadChunk = useCallback(
    async (sid: string, chunk: Blob, index: number) => {
      try {
        const fd = new FormData();
        fd.append('chunk', chunk, `chunk-${index}.webm`);
        fd.append('chunkIndex', index.toString());

        const res = await fetch(`${API_BASE}/api/recordings/session/${sid}/chunk`, {
          method: 'POST',
          body: fd,
        });

        if (res.ok) {
          const data = await res.json();
          setBytesUploaded((prev) => prev + (data.bytesWritten ?? 0));
        }
      } catch (err) {
        console.warn('[Recording] Chunk upload failed:', err);
      }
    },
    []
  );

  const startRecording = useCallback(
    async (roomId?: string, episodeTitle?: string) => {
      if (!canvasRef.current) return;

      const videoStream = canvasRef.current.captureStream(30);
      let audioStream: MediaStream | null = null;
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch {
        audioStream = null;
      }
      const stream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...(audioStream?.getAudioTracks() ?? []),
      ]);
      const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      chunksRef.current = [];
      chunkIndexRef.current = 0;
      setBytesUploaded(0);
      setRecordingBlob(null);

      // Start the server session before recording so the first chunk is not lost.
      if (serverSaveEnabled && roomId) {
        try {
          const response = await fetch(`${API_BASE}/api/recordings/session/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId, episodeTitle }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          sessionIdRef.current = data.sessionId;
          setSessionId(data.sessionId);
        } catch (err) {
          console.warn('[Recording] Failed to start server session:', err);
        }
      }

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);

          // Upload chunk to server
          if (serverSaveEnabled && sessionIdRef.current) {
            const idx = chunkIndexRef.current++;
            const upload = uploadChunk(sessionIdRef.current, e.data, idx);
            uploadQueueRef.current.push(upload);
          }
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        setRecordingBlob(blob);
        audioStream?.getTracks().forEach((track) => track.stop());
      };

      recorder.start(1000);
      mediaRecorderRef.current = recorder;

      setDuration(0);
      timerRef.current = setInterval(() => {
        setDuration((prev) => prev + 1);
      }, 1000);

      setIsRecording(true);
    },
    [canvasRef, serverSaveEnabled, uploadChunk]
  );

  const stopRecording = useCallback(async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (autoSaveTimerRef.current) {
      clearInterval(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    // Wait for the final MediaRecorder data event and all chunk uploads.
    await new Promise<void>((resolve) => {
      if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
        resolve();
        return;
      }
      const recorder = mediaRecorderRef.current;
      const previousStop = recorder.onstop;
      recorder.onstop = (event) => {
        previousStop?.call(recorder, event);
        resolve();
      };
      recorder.stop();
    });
    await Promise.all(uploadQueueRef.current);
    uploadQueueRef.current = [];

    // Finalize server session
    if (serverSaveEnabled && sessionIdRef.current) {
      try {
        const res = await fetch(
          `${API_BASE}/api/recordings/session/${sessionIdRef.current}/finalize`,
          { method: 'POST' }
        );
        if (res.ok) {
          const data = await res.json();
          console.log('[Recording] Server finalized:', data.filename, `(${data.size} bytes)`);
        }
      } catch (err) {
        console.warn('[Recording] Failed to finalize server session:', err);
      }
    }

    sessionIdRef.current = null;
    setSessionId(null);
    setIsRecording(false);
  }, [serverSaveEnabled]);

  const downloadRecording = useCallback(() => {
    if (!recordingBlob) return;

    const url = URL.createObjectURL(recordingBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `connecting-dot-${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [recordingBlob]);

  return {
    isRecording,
    duration,
    recordingBlob,
    sessionId,
    bytesUploaded,
    serverSaveEnabled,
    setServerSaveEnabled,
    startRecording,
    stopRecording,
    downloadRecording,
  };
};

export default useRecording;
