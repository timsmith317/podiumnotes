import { registerWebModule, NativeModule } from 'expo';

class SpellCheckModule extends NativeModule<{}> {}

export default registerWebModule(SpellCheckModule, 'SpellCheckModule');
