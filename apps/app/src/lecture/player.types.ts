/** Plays one audio chunk at a time (docs/lecture-mode.md §6). Times in seconds within the chunk. */
export interface ChunkPlayer {
  load(uri: string): Promise<void>;
  play(): void;
  pause(): void;
  seek(sec: number): void;
  setRate(rate: number): void;
  /** Position in the loaded chunk (s). */
  position(): number;
  /** Reached the end of the loaded chunk. */
  ended(): boolean;
  release(): void;
}
