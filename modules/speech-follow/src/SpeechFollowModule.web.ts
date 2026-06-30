import { registerWebModule, NativeModule } from 'expo';

class SpeechFollowModule extends NativeModule<{}> {}

export default registerWebModule(SpeechFollowModule, 'SpeechFollowModule');
