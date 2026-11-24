import { requireOptionalNativeModule } from 'expo';

/** A transcript line, times in ms relative to the start of the audio file. */
export interface NativeSegment { t0: number; t1: number; text: string; words?: { w: string; t0: number; t1: number }[] }

export interface QalmLectureModuleType {
  /**
   * Whether on-device recognition works here for `lang` (BCP-47; '' = the device language): iPad needs a recognizer
   * that supports on-device recognition and the user's permission; Android needs Android 13+ with an on-device
   * recognizer that has the language installed.
   */
  isAvailable(lang: string): Promise<{ available: boolean; why?: string }>;
  /** Transcribes a recorded chunk (file:// uri) on the device. Never sends audio anywhere. */
  transcribeFile(uri: string, lang: string): Promise<NativeSegment[]>;
}

/** Native module "QalmLecture" (iOS: QalmLectureModule, Android: app.qalm.lecture.QalmLectureModule); null on web. */
export const QalmLecture = requireOptionalNativeModule<QalmLectureModuleType>('QalmLecture');
