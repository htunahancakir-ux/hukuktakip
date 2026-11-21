# Android lifecycle checks

Use only a disposable emulator. These checks refuse a real pairing token or granted `CALL_PHONE` permission. They never make calls. Do not grant phone permission to this test installation.

Build the production APK normally and the separate, same-signature test APK with `build.ps1 -LifecycleTestApk`. Never publish the test APK. Install both, then allow the test package through Android's battery optimization in the emulator:

```sh
adb shell cmd deviceidle whitelist +com.hanhukuk.gsm
adb shell am instrument -w com.hanhukuk.gsm.tests/com.hanhukuk.gsm.tests.LifecycleInstrumentation
```

This checks explicit stop, unpaired devices, disabled boot preference, permission pause without loss of the enabled choice, and package replacement handling.

For an actual reboot, prepare synthetic state and then launch the application normally **after instrumentation finishes**. Instrumentation cleanup force-stops its target process; testing that artificial stopped state would not reproduce a user who has opened and enabled the app.

```sh
adb shell am instrument -w -e mode boot-prepare com.hanhukuk.gsm.tests/com.hanhukuk.gsm.tests.LifecycleInstrumentation
adb shell am start -W -n com.hanhukuk.gsm/.MainActivity
adb reboot
# Wait for sys.boot_completed and Android's BOOT_COMPLETED broadcast processing.
adb shell am instrument -w -e mode boot-verify com.hanhukuk.gsm.tests/com.hanhukuk.gsm.tests.LifecycleInstrumentation
```

The verification requires the persisted system resume action to be `BOOT_COMPLETED`, retained pairing/device data, and the expected pause due to intentionally missing phone permission. `update-prepare` and `update-verify` similarly verify an in-place APK upgrade. A successful instrumentation result includes `passed`; Android's shell exit code alone is insufficient to determine success.

`PairingQrTest.java` takes a directory with `valid.gif`, `untrusted.gif` and `incomplete.gif` produced by `lib/acr-qr.cjs`. Compile it with the production `PairingCode.java`, `QrPairingCode.java` and pinned ZXing JAR. It validates the actual web image using the same local luminance decoder as the camera, including 180-degree rotation and rejection of unrelated URLs.
