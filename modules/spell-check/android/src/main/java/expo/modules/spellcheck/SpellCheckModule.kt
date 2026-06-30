package expo.modules.spellcheck

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class SpellCheckModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SpellCheck")
  }
}
