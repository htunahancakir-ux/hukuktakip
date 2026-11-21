param(
    [Parameter(Mandatory = $true)][string]$AndroidSdk,
    [Parameter(Mandatory = $true)][string]$JavaHome,
    [Parameter(Mandatory = $true)][string]$SigningKey,
    [Parameter(Mandatory = $true)][string]$Output,
    [switch]$LifecycleTestApk,
    [string]$ZxingJar
)

$ErrorActionPreference = 'Stop'
$env:JAVA_HOME = $JavaHome
$androidJar = Join-Path $AndroidSdk 'platforms/android-36.1/android.jar'
$buildTools = Join-Path $AndroidSdk 'build-tools/36.1.0'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('han-gsm-build-' + [guid]::NewGuid())
$outputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output)

function Invoke-BuildStep {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Build step failed: $Program ($LASTEXITCODE)" }
}

try {
    if (-not $env:HAN_GSM_KEY_PASS) { throw 'Set HAN_GSM_KEY_PASS to the signing key password.' }
    $classes = (New-Item -ItemType Directory -Path (Join-Path $temp 'classes') -Force).FullName
    $checks = (New-Item -ItemType Directory -Path (Join-Path $temp 'checks')).FullName
    $dex = (New-Item -ItemType Directory -Path (Join-Path $temp 'dex')).FullName
    $raw = Join-Path $temp 'unsigned.apk'
    $aligned = Join-Path $temp 'aligned.apk'
    $jar = Join-Path $temp 'classes.jar'
    if (-not $LifecycleTestApk) {
        if (-not $ZxingJar) {
            $ZxingJar = Join-Path $temp 'zxing-core-3.5.4.jar'
            Invoke-WebRequest -Uri 'https://repo.maven.apache.org/maven2/com/google/zxing/core/3.5.4/core-3.5.4.jar' -OutFile $ZxingJar
        }
        if ((Get-FileHash -LiteralPath $ZxingJar -Algorithm SHA256).Hash -ne '71DE5D89341B5FCF5DD89DA7F44E84D825D0E084CDF3EC77C9ABE26B0F0CEB13') {
            throw 'Unexpected ZXing core artifact hash.'
        }
    }
    $sources = if ($LifecycleTestApk) {
        @((Join-Path $PSScriptRoot 'tests/LifecycleInstrumentation.java'))
    } else {
        @(Get-ChildItem (Join-Path $PSScriptRoot 'src') -Recurse -Filter '*.java' | ForEach-Object FullName)
    }
    $manifest = if ($LifecycleTestApk) { 'tests/AndroidManifest.xml' } else { 'AndroidManifest.xml' }
    Invoke-BuildStep (Join-Path $buildTools 'aapt2.exe') @(
        'link', '--manifest', (Join-Path $PSScriptRoot $manifest), '-I', $androidJar,
        '--min-sdk-version', '26', '--target-sdk-version', '35', '-o', $raw)
    Invoke-BuildStep (Join-Path $JavaHome 'bin/javac.exe') (
        @('-encoding', 'UTF-8', '--release', '8', '-classpath', "$androidJar;$ZxingJar", '-d', $classes) + $sources)
    if (-not $LifecycleTestApk) {
        Invoke-BuildStep (Join-Path $JavaHome 'bin/javac.exe') @(
            '-encoding', 'UTF-8', '-classpath', $classes, '-d', $checks,
            (Join-Path $PSScriptRoot 'tests/PairingCodeTest.java'))
        Invoke-BuildStep (Join-Path $JavaHome 'bin/java.exe') @(
            '-classpath', "$classes;$checks", 'com.hanhukuk.gsm.PairingCodeTest')
    }
    Invoke-BuildStep (Join-Path $JavaHome 'bin/jar.exe') @('cf', $jar, '-C', $classes, '.')
    $dexInputs = @('--min-api', '26', '--lib', $androidJar, '--output', $dex, $jar)
    if (-not $LifecycleTestApk) { $dexInputs += $ZxingJar }
    Invoke-BuildStep (Join-Path $buildTools 'd8.bat') $dexInputs
    Invoke-BuildStep (Join-Path $JavaHome 'bin/jar.exe') @('uf', $raw, '-C', $dex, 'classes.dex')
    if (-not $LifecycleTestApk) {
        Invoke-BuildStep (Join-Path $JavaHome 'bin/jar.exe') @('uf', $raw,
            '-C', $PSScriptRoot, 'ZXING-LICENSE.txt', '-C', $PSScriptRoot, 'ZXING-NOTICE.txt')
    }
    Invoke-BuildStep (Join-Path $buildTools 'zipalign.exe') @('-f', '4', $raw, $aligned)
    $apksigner = Join-Path $buildTools 'apksigner.bat'
    Invoke-BuildStep $apksigner @('sign', '--ks', $SigningKey, '--ks-key-alias', 'han-gsm',
        '--ks-pass', 'env:HAN_GSM_KEY_PASS', '--out', $outputPath, $aligned)
    Invoke-BuildStep $apksigner @('verify', '--print-certs', $outputPath)
} finally {
    if ((Test-Path -LiteralPath $temp) -and
        (Resolve-Path -LiteralPath $temp).ProviderPath -eq $temp) {
        Remove-Item -LiteralPath $temp -Recurse -Force
    }
}
