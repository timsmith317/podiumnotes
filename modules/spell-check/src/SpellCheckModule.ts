import { NativeModule, requireNativeModule } from 'expo';

declare class SpellCheckModule extends NativeModule<{}> {}

export default requireNativeModule<SpellCheckModule>('SpellCheck');
