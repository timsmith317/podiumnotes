
# File: apply_share_patch.py → ~/Projects/podiumnotes/tools/apply_share_patch.py
#
# Reapplies the share-extension timing fix to expo-share-intent after a version
# bump. Run it, then `npx patch-package expo-share-intent` to capture the result.
#
# WHY THIS EXISTS
# The extension is invisible (hideView) and completes ~140ms after launch, while
# the host app's share-sheet PRESENTATION animation is still running (~400-500ms).
# The host then dismisses a sheet that is still presenting, corrupting its
# transition state and leaving it deaf to touch. Apple's own apps tolerate the
# overlap; Simplenote and Google Keep do not. Diagnosed from device logs.
#
# The fix has three parts, and all three matter:
#   1. Gate completion on viewDidAppear (+ cushion) so dismissal never overlaps
#      presentation.
#   2. Complete BEFORE switching apps, so the host tears its sheet down while
#      still frontmost.
#   3. Hold the process alive across the delay with performExpiringActivity, or
#      the system suspends the extension before `open` dispatches.
#   4. Release the gate on a timer as well as from viewDidAppear. Parts 1-3
#      assume viewDidAppear runs. With hideView the content handling starts in
#      viewDidLoad, so a redirect can be requested before any appearance
#      callback — and if none ever arrives, as appears to happen on macOS, the
#      request parks forever and the user sees an empty share sheet that never
#      closes. A gate with no timeout is a deadlock waiting for a platform that
#      behaves differently.

import sys, pathlib

TARGET = pathlib.Path(
    'node_modules/expo-share-intent/plugin/build/ios/ShareExtensionViewController.swift'
)

OLD_APPEAR = """  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    if !hideView {
      handleViewLoad()
    }"""

NEW_APPEAR = """  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    // PATCHED: viewDidAppear fires when the share sheet's presentation
    // transition completes. A small cushion covers any residual host-side
    // sheet animation, then any redirect requested early is released.
    DispatchQueue.main.asyncAfter(deadline: .now() + presentationSettleSeconds) { [weak self] in
      self?.settlePresentation()
    }
    if !hideView {
      handleViewLoad()
    }"""

OLD_LOAD = """  override func viewDidLoad() {
    super.viewDidLoad()
    if hideView {"""

NEW_LOAD = """  override func viewDidLoad() {
    super.viewDidLoad()
    // PATCHED: release the completion gate on a timer as well as from
    // viewDidAppear, which is not guaranteed to run. A share that is slower
    // than it needs to be is a nuisance; one that never completes is a broken
    // feature, and that is what an ungated-but-unreleased request looks like.
    DispatchQueue.main.asyncAfter(deadline: .now() + presentationFallbackSeconds) { [weak self] in
      self?.settlePresentation()
    }
    if hideView {"""

OLD_REDIRECT = """  private func redirectToHostApp(type: RedirectType) {
    let nonce = UUID().uuidString
    let url = URL(string: "\\(shareProtocol)://dataUrl=\\(sharedKey)?nonce=\\(nonce)#\\(type)")!
    var responder = self as UIResponder?

    while responder != nil {
      if let application = responder as? UIApplication {
        if application.canOpenURL(url) {
          application.open(url)
        } else {
          NSLog("redirectToHostApp canOpenURL KO: \\(shareProtocol)")
          self.dismissWithError(
            message: "Application not found, invalid url scheme \\(shareProtocol)")
          return
        }
      }
      responder = responder!.next
    }
    extensionContext!.completeRequest(returningItems: [], completionHandler: nil)
  }"""

NEW_REDIRECT = """  // PATCHED (Podium Notes): see tools/apply_share_patch.py for the full
  // reasoning. Completion is gated on the host's share sheet finishing its
  // presentation, then sequenced completion-first so the host tears the sheet
  // down while frontmost.
  private var didCompleteExtension = false
  private var presentationSettled = false
  private var pendingRedirectType: RedirectType? = nil

  // Cushion after viewDidAppear before completion may fire.
  private let presentationSettleSeconds: TimeInterval = 0.3
  // How long the source app gets to finish teardown before the app switch.
  private let redirectDelaySeconds: TimeInterval = 1.2
  // Longest the gate may stay shut when no appearance callback ever arrives.
  private let presentationFallbackSeconds: TimeInterval = 1.5

  // Opens the gate once, from whichever of the two paths gets here first.
  private func settlePresentation() {
    guard !presentationSettled else { return }
    presentationSettled = true
    if let pending = pendingRedirectType {
      pendingRedirectType = nil
      performRedirect(type: pending)
    }
  }

  private func completeExtensionRequest() {
    guard !didCompleteExtension else { return }
    didCompleteExtension = true
    extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
  }

  private func redirectToHostApp(type: RedirectType) {
    // Never begin completion while the share sheet may still be presenting.
    guard presentationSettled else {
      pendingRedirectType = type
      return
    }
    performRedirect(type: type)
  }

  private func performRedirect(type: RedirectType) {
    let nonce = UUID().uuidString
    let url = URL(string: "\\(shareProtocol)://dataUrl=\\(sharedKey)?nonce=\\(nonce)#\\(type)")!
    var responder = self as UIResponder?
    var hostApplication: UIApplication? = nil

    while responder != nil {
      if let application = responder as? UIApplication {
        hostApplication = application
        break
      }
      responder = responder!.next
    }

    guard let application = hostApplication else {
      NSLog("redirectToHostApp could not resolve UIApplication via responder chain")
      completeExtensionRequest()
      return
    }

    guard application.canOpenURL(url) else {
      NSLog("redirectToHostApp canOpenURL KO: \\(shareProtocol)")
      self.dismissWithError(
        message: "Application not found, invalid url scheme \\(shareProtocol)")
      return
    }

    // 1. Complete first: the source app dismisses its sheet while frontmost,
    //    from a fully-presented state.
    completeExtensionRequest()

    // 2. Deferred app switch, process held alive across the delay.
    let delay = redirectDelaySeconds
    DispatchQueue.global(qos: .userInitiated).async {
      ProcessInfo.processInfo.performExpiringActivity(withReason: "redirectToHostApp") { expired in
        guard !expired else {
          NSLog("redirectToHostApp expiring activity expired before open could fire")
          return
        }
        Thread.sleep(forTimeInterval: delay)
        DispatchQueue.main.sync {
          application.open(url, options: [:], completionHandler: nil)
        }
        // Hold briefly so the open is fully dispatched before suspension.
        Thread.sleep(forTimeInterval: 0.5)
      }
    }
  }"""


def main():
    if not TARGET.exists():
        sys.exit(f'FAIL: {TARGET} not found — run from the project root')
    s = TARGET.read_text()

    if 'presentationSettled' in s:
        print('Already patched; nothing to do.')
        return

    for name, old in (('viewDidLoad', OLD_LOAD), ('viewDidAppear', OLD_APPEAR),
                      ('redirectToHostApp', OLD_REDIRECT)):
        n = s.count(old)
        if n != 1:
            sys.exit(
                f'FAIL: expected exactly one match for {name}, found {n}.\n'
                'The upstream file has changed shape — reapply the fix by hand '
                'and update this script.'
            )

    s = s.replace(OLD_LOAD, NEW_LOAD, 1)
    s = s.replace(OLD_APPEAR, NEW_APPEAR, 1)
    s = s.replace(OLD_REDIRECT, NEW_REDIRECT, 1)
    TARGET.write_text(s)
    print('Patched. Now run:  npx patch-package expo-share-intent')


main()
