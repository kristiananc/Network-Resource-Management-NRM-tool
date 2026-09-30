[CmdletBinding()]
param(
    [string]$EnvFile = (Join-Path $PSScriptRoot 'local-api.env')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$LogDirectory = Join-Path $RepoRoot 'local-api\logs'
$ServiceLog = Join-Path $LogDirectory 'nrm-local-api.service.log'
$RunStamp = (Get-Date).ToString('yyyyMMddTHHmmssfff')
$StdoutLog = Join-Path $LogDirectory "nrm-local-api.$RunStamp.stdout.log"
$StderrLog = Join-Path $LogDirectory "nrm-local-api.$RunStamp.stderr.log"

New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null

function Write-ServiceLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    $Timestamp = (Get-Date).ToString('o')
    Add-Content -LiteralPath $ServiceLog -Encoding UTF8 -Value "[$Timestamp] $Message"
}

function Import-NrmEnvironmentFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Environment file not found: $Path"
    }

    $LineNumber = 0
    foreach ($RawLine in Get-Content -LiteralPath $Path) {
        $LineNumber += 1
        $Line = $RawLine.Trim()
        if (-not $Line -or $Line.StartsWith('#')) {
            continue
        }

        $Separator = $Line.IndexOf('=')
        if ($Separator -le 0) {
            throw "Invalid environment entry at line $LineNumber. Expected NAME=VALUE."
        }

        $Name = $Line.Substring(0, $Separator).Trim()
        $Value = $Line.Substring($Separator + 1).Trim()
        if ($Name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
            throw "Invalid environment variable name at line $LineNumber."
        }

        if ($Value.Length -ge 2) {
            $First = $Value.Substring(0, 1)
            $Last = $Value.Substring($Value.Length - 1, 1)
            if (($First -eq '"' -and $Last -eq '"') -or
                ($First -eq "'" -and $Last -eq "'")) {
                $Value = $Value.Substring(1, $Value.Length - 2)
            }
        }

        [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
    }
}

function Get-RequiredEnvironmentValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    $Value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Required environment variable is missing: $Name"
    }
    return $Value.Trim()
}

function Resolve-RepositoryPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $Path))
}

try {
    Import-NrmEnvironmentFile -Path $EnvFile

    $InternalToken = Get-RequiredEnvironmentValue -Name 'NRM_INTERNAL_API_TOKEN'
    $OllamaBaseUrl = Get-RequiredEnvironmentValue -Name 'NRM_OLLAMA_BASE_URL'
    $PythonPath = Resolve-RepositoryPath (Get-RequiredEnvironmentValue -Name 'PYTHONPATH')
    $PythonExecutable = Resolve-RepositoryPath (Get-RequiredEnvironmentValue -Name 'NRM_PYTHON_EXE')

    if (-not (Test-Path -LiteralPath $PythonPath -PathType Container)) {
        throw "PYTHONPATH directory not found: $PythonPath"
    }
    if (-not (Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) {
        throw "Python executable not found: $PythonExecutable"
    }

    $ParsedOllamaUri = $null
    if (-not ([Uri]::TryCreate($OllamaBaseUrl, [UriKind]::Absolute, [ref]$ParsedOllamaUri)) -or
        $ParsedOllamaUri.Scheme -notin @('http', 'https')) {
        throw 'NRM_OLLAMA_BASE_URL must be an absolute HTTP or HTTPS URL.'
    }

    # Assign the resolved values after validation. The token is never written to logs.
    [Environment]::SetEnvironmentVariable('NRM_INTERNAL_API_TOKEN', $InternalToken, 'Process')
    [Environment]::SetEnvironmentVariable('NRM_OLLAMA_BASE_URL', $OllamaBaseUrl, 'Process')
    [Environment]::SetEnvironmentVariable('PYTHONPATH', $PythonPath, 'Process')

    Set-Location -LiteralPath $RepoRoot
    Write-ServiceLog ("Starting NRM Local API on 127.0.0.1:8000 with Python " +
        "$PythonExecutable; stdout=$StdoutLog; stderr=$StderrLog")

    $Uvicorn = Start-Process -FilePath $PythonExecutable `
        -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000') `
        -WorkingDirectory $RepoRoot `
        -NoNewWindow `
        -PassThru `
        -Wait `
        -RedirectStandardOutput $StdoutLog `
        -RedirectStandardError $StderrLog
    $ExitCode = $Uvicorn.ExitCode
    Write-ServiceLog "NRM Local API exited with code $ExitCode."
    exit $ExitCode
}
catch {
    Write-ServiceLog ("NRM Local API launcher failed: " + $_.Exception.Message)
    exit 1
}
