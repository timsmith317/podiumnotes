Pod::Spec.new do |s|
  s.name           = 'SpeechPlayer'
  s.version        = '1.0.0'
  s.summary        = 'Listen mode: on-device speech synthesis to file + background audio playback with Now Playing integration'
  s.description    = 'Renders note text to an audio file with AVSpeechSynthesizer and plays it via AVPlayer with lock screen / CarPlay Now Playing and remote command support.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
