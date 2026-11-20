param(
    [Parameter(Mandatory = $true)][string]$AndroidSdk,
    [Parameter(Mandatory = $true)][string]$JavaHome,
    [Parameter(Mandatory = $true)][string]$SigningKey,
    [Parameter(Mandatory = $true)][string]$Output
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
    $sources = @(Get-ChildItem (Join-Path $PSScriptRoot 'src') -Recurse -Filter '*.java' | ForEach-Object FullName)
    Invoke-BuildStep (Join-Path $buildTools 'aapt2.exe') @(
        'link', '--manifest', (Join-Path $PSScriptRoot 'AndroidManifest.xml'), '-I', $androidJar,
        '--min-sdk-version', '26', '--target-sdk-version', '35', '-o', $raw)
    Invoke-BuildStep (Join-Path $JavaHome 'bin/javac.exe') (
        @('-encoding', 'UTF-8', '--release', '8', '-classpath', $androidJar, '-d', $classes) + $sources)
    Invoke-BuildStep (Join-Path $JavaHome 'bin/javac.exe') @(
        '-encoding', 'UTF-8', '-classpath', $classes, '-d', $checks,
        (Join-Path $PSScriptRoot 'tests/PairingCodeTest.java'))
    Invoke-BuildStep (Join-Path $JavaHome 'bin/java.exe') @(
        '-classpath', "$classes;$checks", 'com.hanhukuk.gsm.PairingCodeTest')
    Invoke-BuildStep (Join-Path $JavaHome 'bin/jar.exe') @('cf', $jar, '-C', $classes, '.')
    Invoke-BuildStep (Join-Path $buildTools 'd8.bat') @('--min-api', '26', '--lib', $androidJar, '--output', $dex, $jar)
    Invoke-BuildStep (Join-Path $JavaHome 'bin/jar.exe') @('uf', $raw, '-C', $dex, 'classes.dex')
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
