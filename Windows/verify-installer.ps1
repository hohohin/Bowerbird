param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$Version
)

$ErrorActionPreference = "Stop"
$Package = Get-Item -LiteralPath $Installer
if ($Package.VersionInfo.ProductVersion -ne $Version) {
    throw "NSIS embedded product version differs from the release configuration."
}
$Unpack = (Get-Command 7z -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$TempDir = Join-Path ([IO.Path]::GetTempPath()) ("bowerbird-check-" + [Guid]::NewGuid().ToString("N"))
$DesktopExe = Join-Path $TempDir "bowerbird-desktop.exe"
[void][IO.Directory]::CreateDirectory($TempDir)
try {
    & $Unpack e $Package.FullName "-o$TempDir" bowerbird-desktop.exe -y | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($DesktopExe)) {
        throw "Cannot extract the desktop executable from the NSIS installer."
    }
    if ((Get-Item -LiteralPath $DesktopExe).VersionInfo.ProductVersion -ne $Version) {
        throw "Packaged desktop version differs from the release configuration."
    }
    $Reader = [IO.BinaryReader]::new([IO.File]::OpenRead($DesktopExe))
    try {
        $Reader.BaseStream.Position = 0x3c
        $Reader.BaseStream.Position = $Reader.ReadUInt32()
        if ($Reader.ReadUInt32() -ne 0x4550 -or $Reader.ReadUInt16() -ne 0x8664) {
            throw "The packaged desktop build must target Windows x64."
        }
    }
    finally { $Reader.Dispose() }
}
finally {
    [IO.File]::Delete($DesktopExe)
    [IO.Directory]::Delete($TempDir)
}
