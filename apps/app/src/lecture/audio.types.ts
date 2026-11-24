/** One finished audio chunk: a complete, standalone file (docs/lecture-mode.md §1). */
export interface RecordedChunk {
  bytes: Uint8Array;
  mime: string;
  /** Its length as recorded (ms). */
  durMs: number;
  /** Native: the file the recorder wrote (on-device transcription reads it; deleted once it is stored). */
  uri?: string;
}

/** Records one chunk at a time on a session's microphone. */
export interface ChunkRecorder {
  /** Starts a new chunk. */
  start(): Promise<void>;
  /** Ends the current chunk; null when nothing was recorded. */
  stop(): Promise<RecordedChunk | null>;
  /** Ends the session: frees the microphone (and the background service or audio session). */
  release(): Promise<void>;
  /**
   * The OS took the microphone or the recorder failed (a call, Siri, another app, media services reset): `cb` runs
   * once per chunk. Returns the unsubscribe.
   */
  onInterrupt?(cb: (why: string) => void): () => void;
  /** False when the platform says the current chunk isn't recording any more (checked now and then). */
  isRecording?(): boolean;
  /** Native: the file the current chunk is being written to (a crash leaves it behind: recovered at next start). */
  currentUri?(): string | null;
}

export interface AudioBackend {
  /** Asks for the microphone; false when refused or unavailable. */
  permission(): Promise<boolean>;
  open(): Promise<ChunkRecorder>;
  /** Native: writes bytes to a temporary file and returns its uri (a piece of a long chunk, for on-device transcription). */
  writeTemp?(bytes: Uint8Array, ext: string): Promise<string>;
  /** Native: deletes a recorder or temporary file (never throws). */
  discard?(uri: string): Promise<void>;
  /** Native: a leftover recorder file's bytes, or null when it is gone. */
  readFile?(uri: string): Promise<Uint8Array | null>;
}
