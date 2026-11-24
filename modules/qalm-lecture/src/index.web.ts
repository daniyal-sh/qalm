import type { QalmLectureModuleType } from './index';

export type { NativeSegment, QalmLectureModuleType } from './index';

/** Web and Electron have no on-device recognizer module (macOS desktop uses its own helper over IPC). */
export const QalmLecture: QalmLectureModuleType | null = null;
