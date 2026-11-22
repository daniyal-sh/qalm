import { requireNativeModule } from 'expo';

import type { QalmInkModuleType } from './QalmInk.types';

/** Native module "QalmInk" (Android: app.qalm.ink.QalmInkModule, iOS: QalmInkModule). */
export default requireNativeModule<QalmInkModuleType>('QalmInk');
