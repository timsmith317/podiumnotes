// modules/spell-check/ios/SpellCheckModule.swift
//
// Replaces the generated SpellCheckModule.swift. Exposes Apple's UITextChecker
// to JS: check(text, language) returns every misspelled word with its range and
// up to five correction suggestions. Indices are UTF-16 offsets (NSString),
// which line up with JavaScript string indices.

import ExpoModulesCore
import UIKit

public class SpellCheckModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SpellCheck")

    Function("check") { (text: String, language: String) -> [[String: Any]] in
      let checker = UITextChecker()
      let nsText = text as NSString
      let total = nsText.length
      let lang = UITextChecker.availableLanguages.contains(language) ? language : "en_US"

      var results: [[String: Any]] = []
      var searchStart = 0

      while searchStart < total {
        let misspelled = checker.rangeOfMisspelledWord(
          in: text,
          range: NSRange(location: 0, length: total),
          startingAt: searchStart,
          wrap: false,
          language: lang
        )

        if misspelled.location == NSNotFound { break }

        let word = nsText.substring(with: misspelled)
        let guesses = checker.guesses(forWordRange: misspelled, in: text, language: lang) ?? []

        results.append([
          "start": misspelled.location,
          "length": misspelled.length,
          "word": word,
          "suggestions": Array(guesses.prefix(5)),
        ])

        searchStart = misspelled.location + misspelled.length
      }

      return results
    }
  }
}
