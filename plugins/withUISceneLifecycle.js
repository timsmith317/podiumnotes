// File: withUISceneLifecycle.js → ~/Projects/podiumnotes/plugins/withUISceneLifecycle.js
//
// Adopts the UIKit scene-based life cycle, which the iOS 27 SDK REQUIRES.
// Without it UIKit refuses to launch the app:
//
//   Application failed to launch: UIScene life cycle is required for apps
//   built with this SDK.
//
// Expo SDK 57.0.23 carries the runtime support but still generates an
// AppDelegate/window template, and the official opt-in plugin
// (@config-plugins/expo-uiscene-lifecycle) is not on npm yet. This does the
// same job against our generated AppDelegate.
//
// THREE PARTS, ALL REQUIRED
//
// 1. UIApplicationSceneManifest in Info.plist, naming our SceneDelegate.
// 2. AppDelegate stops creating the window and starting React Native.
// 3. A SceneDelegate that creates the window FROM the scene and starts React
//    Native there.
//
// Doing only (1) is the trap: the app launches and shows a BLACK SCREEN,
// because the window AppDelegate built with UIWindow(frame:) was never
// attached to the UIWindowScene.
//
// URL FORWARDING — the part specific to this app
//
// Under the scene life cycle, openURL and userActivity no longer reach
// AppDelegate. Podium Notes depends on them twice over: the share extension
// redirects back through a custom scheme, and expo-share-intent listens via
// an ExpoAppDelegate subscriber. So the scene handlers forward to
// AppDelegate's own methods rather than calling RCTLinkingManager directly —
// going through AppDelegate means super (ExpoAppDelegate) still notifies its
// subscribers, which is what keeps share import working.
//
// Cold-start URLs are passed through launchOptions so Linking.getInitialURL()
// still resolves on a fresh launch.
//
// Anchors are asserted. A silent miss here only shows up at launch, which is
// exactly the failure this plugin exists to remove.

const { withInfoPlist, withAppDelegate } = require('expo/config-plugins');

const WINDOW_BLOCK = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
`;

const SCENE_DELEGATE = `
// MARK: - Scene life cycle (required by the iOS 27 SDK)
//
// The window is created FROM the scene; creating it with UIWindow(frame:) in
// AppDelegate leaves it unattached and the app renders black.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else { return }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    // AppDelegate keeps a reference too: LogBox and other RN internals still
    // reach for it.
    appDelegate.window = window

    // Carry a cold-start URL through so Linking.getInitialURL() resolves —
    // this is how a share-sheet redirect arrives when the app was not running.
    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[.url] = url
    }

    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)

    for activity in connectionOptions.userActivities {
      _ = appDelegate.application(
        UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
  }

  // Forward through AppDelegate rather than straight to RCTLinkingManager, so
  // ExpoAppDelegate's subscribers (expo-share-intent among them) still fire.
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    for context in URLContexts {
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: [:])
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    _ = appDelegate.application(
      UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}
`;

function withSceneManifest(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    };
    return cfg;
  });
}

function withSceneDelegate(config) {
  return withAppDelegate(config, (cfg) => {
    let src = cfg.modResults.contents;

    if (src.includes('class SceneDelegate')) return cfg;   // already applied

    if (!src.includes(WINDOW_BLOCK)) {
      throw new Error(
        '[withUISceneLifecycle] could not find the window/startReactNative block ' +
        'in AppDelegate.swift. The Expo template has changed — update ' +
        'plugins/withUISceneLifecycle.js before building, or the app will fail ' +
        'to launch on iOS 27.'
      );
    }

    // The factory is still built and retained in didFinishLaunching; only the
    // window and the React Native start move to the scene.
    src = src.replace(
      WINDOW_BLOCK,
      '    // Window creation and startReactNative live in SceneDelegate below —\n' +
      '    // the iOS 27 SDK requires the scene life cycle.\n'
    );

    cfg.modResults.contents = src.trimEnd() + '\n' + SCENE_DELEGATE;
    return cfg;
  });
}

module.exports = function withUISceneLifecycle(config) {
  return withSceneDelegate(withSceneManifest(config));
};
