import { NativeModule, requireNativeModule } from 'expo';

declare class SpeechFollowModule extends NativeModule<{}> {}

export default requireNativeModule<SpeechFollowModule>('SpeechFollow');
