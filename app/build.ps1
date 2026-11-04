# For working on Aster: redraws the art with Node, then builds the app with the C#
# compiler Windows ships. The plugin builds the app by itself on first run, from the
# art already checked in, so people who only use Aster never need this.
#   .\build.ps1 -Out C:\somewhere\Aster.exe
param([Parameter(Mandatory)][string]$Out)

$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'art.mjs') --preview (Join-Path $PSScriptRoot '..\docs\aster.png')
if ($LASTEXITCODE) { throw 'art failed' }

$fx = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
$art = Join-Path $PSScriptRoot 'frames'
& "$fx\csc.exe" /nologo /optimize /target:winexe "/out:$Out" "/lib:$fx\WPF" `
    /r:PresentationFramework.dll /r:PresentationCore.dll /r:WindowsBase.dll /r:System.Xaml.dll /r:System.Web.Extensions.dll `
    "/resource:$art\sheet.png,sheet.png" "/resource:$art\icons.png,icons.png" "/resource:$art\manifest.json,manifest.json" `
    (Join-Path $PSScriptRoot 'Aster.cs') (Join-Path $PSScriptRoot 'Menu.cs')
if ($LASTEXITCODE) { throw 'compile failed' }
"built $Out"
