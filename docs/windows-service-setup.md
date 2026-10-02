# NRM Local API Windows Service Setup

This runbook installs the existing NRM FastAPI process as a persistent Windows
service. Run every command on the Windows server in **PowerShell as
Administrator**. The repository only provides the launcher and instructions;
installation and verification are manual operations on that server.

The selected service wrapper is NSSM. It is purpose-built for long-running
console applications, starts through Windows Service Control Manager without a
logged-in user, and restarts the wrapped process after an unexpected exit. The
official NSSM download page says Windows 10 and Server 2016 or newer should use
build 2.24-101 or newer; this runbook uses the official 2.24-101 build.

## 1. Set paths and update the repository

Replace only the repository path in the first command:

```powershell
$RepoRoot = 'C:\path\to\Network-Resource-Management-NRM-tool'
$ServiceName = 'NRMLocalAPI'
$Nssm = 'C:\Tools\nssm\nssm.exe'
Set-Location $RepoRoot
git pull origin main
```

Expected final `git pull` output when already current:

```text
Already up to date.
```

Confirm the required files exist:

```powershell
Test-Path "$RepoRoot\scripts\windows\start-local-api.ps1"
Test-Path "$RepoRoot\scripts\windows\local-api.env.example"
```

Expected:

```text
True
True
```

## 2. Prepare Python and the local environment file

If the existing virtual environment is already running FastAPI successfully,
keep it and only run the final version check. Otherwise create it and install
the versioned project requirements:

```powershell
Set-Location $RepoRoot
py -3 -m venv local-api\.venv
& "$RepoRoot\local-api\.venv\Scripts\python.exe" -m pip install --upgrade pip
& "$RepoRoot\local-api\.venv\Scripts\python.exe" -m pip install -r "$RepoRoot\local-api\requirements.txt"
& "$RepoRoot\local-api\.venv\Scripts\python.exe" -m uvicorn --version
```

Expected final output begins with:

```text
Running uvicorn
```

Create the real, gitignored configuration file:

```powershell
Copy-Item "$RepoRoot\scripts\windows\local-api.env.example" `
  "$RepoRoot\scripts\windows\local-api.env"
notepad "$RepoRoot\scripts\windows\local-api.env"
```

Set the service values in that file. The first four run the text API; the
Twilio credentials and vision model are additionally required before Stage 7
MMS processing can succeed:

```text
NRM_INTERNAL_API_TOKEN=<the existing bearer token also configured in Apps Script>
NRM_OLLAMA_BASE_URL=http://127.0.0.1:11434
PYTHONPATH=local-api
NRM_PYTHON_EXE=local-api\.venv\Scripts\python.exe
NRM_TWILIO_ACCOUNT_SID=<the Twilio Account SID>
NRM_TWILIO_AUTH_TOKEN=<the Twilio Auth Token>
NRM_OLLAMA_VISION_MODEL=qwen2.5vl:3b
```

Do not generate a different bearer token unless Apps Script is updated to the
same value. `NRM_OLLAMA_TEXT_MODEL`, `NRM_OLLAMA_VISION_MODEL`, and
`NRM_OLLAMA_TIMEOUT_SECONDS` may remain at their template defaults. The Twilio
values are local copies needed for authenticated media downloads; never copy
them into a tracked file.

Install the Stage 7 vision model before starting MMS verification:

```powershell
ollama --version
ollama pull qwen2.5vl:3b
ollama list | Select-String 'qwen2.5vl:3b'
```

Expected: Ollama is version 0.7.0 or newer, the pull completes successfully,
and the final command prints a `qwen2.5vl:3b` row. The repository cannot run or
verify these Windows-hosted commands remotely.

Restrict the secret file to the current administrator, Administrators, and the
LocalSystem account used by the service:

```powershell
$EnvFile = "$RepoRoot\scripts\windows\local-api.env"
icacls $EnvFile /inheritance:r
icacls $EnvFile /grant:r "$($env:USERNAME):(R)" "Administrators:(F)" "SYSTEM:(R)"
icacls $EnvFile
```

Expected: the final ACL listing contains the current user, `BUILTIN\Administrators`,
and `NT AUTHORITY\SYSTEM`, and reports `Successfully processed 1 files`.

Confirm Git ignores the real file:

```powershell
Set-Location $RepoRoot
git check-ignore -v scripts/windows/local-api.env
```

Expected output identifies `.gitignore` and `scripts/windows/local-api.env`.

## 3. Dry-run the launcher before registering the service

Ensure no other FastAPI process is using port 8000, then run:

```powershell
Set-Location $RepoRoot
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File "$RepoRoot\scripts\windows\start-local-api.ps1"
```

The omitted `-EnvFile` argument is intentional in this dry run. It verifies the
launcher resolves `local-api.env` from its own executable path under the exact
no-profile, non-interactive `-File` invocation used by NSSM. If this command
returns immediately, inspect the service log before registering the service.

The command remains attached while Uvicorn runs. In a second PowerShell window,
read the bearer token without printing it and call the authenticated endpoint:

```powershell
$RepoRoot = 'C:\path\to\Network-Resource-Management-NRM-tool'
$TokenLine = Select-String -Path "$RepoRoot\scripts\windows\local-api.env" `
  -Pattern '^NRM_INTERNAL_API_TOKEN=' | Select-Object -First 1
$Token = $TokenLine.Line.Substring($TokenLine.Line.IndexOf('=') + 1).Trim().Trim('"').Trim("'")
$Headers = @{ Authorization = "Bearer $Token" }
Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -Headers $Headers
```

Expected:

```text
status service       schema_version
------ -------       --------------
ok     nrm-local-api 1.0
```

Stop the dry run with `Ctrl+C`. Inspect its log:

```powershell
Get-Content "$RepoRoot\local-api\logs\nrm-local-api.service.log" -Tail 50
$LatestStdout = Get-ChildItem "$RepoRoot\local-api\logs\nrm-local-api.*.stdout.log" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$LatestStderr = Get-ChildItem "$RepoRoot\local-api\logs\nrm-local-api.*.stderr.log" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content $LatestStdout.FullName -Tail 50
Get-Content $LatestStderr.FullName -Tail 50
```

Expected lines include `Starting NRM Local API` in the service log and Uvicorn
startup/request messages in the stdout or stderr log. No bearer token should
appear.

The repository also includes a cross-platform source-contract regression. Run
it from the repository root after changing either the launcher or this runbook:

```powershell
python -m unittest discover -s scripts/windows/tests -v
```

Expected summary:

```text
Ran 3 tests

OK
```

## 4. Download and verify NSSM

The official download URL and SHA-1 below are published on the NSSM download
page. NSSM does not use an installer; keep `nssm.exe` at a permanent path after
the service is registered.

```powershell
$NssmZip = "$env:TEMP\nssm-2.24-101-g897c7ad.zip"
Invoke-WebRequest `
  -Uri 'https://www.nssm.cc/ci/nssm-2.24-101-g897c7ad.zip' `
  -OutFile $NssmZip
Get-FileHash -Path $NssmZip -Algorithm SHA1
```

Expected hash:

```text
CA2F6782A05AF85FACF9B620E047B01271EDD11D
```

Do not continue if the hash differs. Extract and install the 64-bit executable:

```powershell
$NssmExtract = "$env:TEMP\nssm-2.24-101"
New-Item -ItemType Directory -Path 'C:\Tools\nssm' -Force | Out-Null
Expand-Archive -Path $NssmZip -DestinationPath $NssmExtract -Force
Copy-Item `
  "$NssmExtract\nssm-2.24-101-g897c7ad\win64\nssm.exe" `
  'C:\Tools\nssm\nssm.exe' -Force
& 'C:\Tools\nssm\nssm.exe' version
```

Expected:

```text
2.24-101-g897c7ad
```

## 5. Register the automatic, restartable service

Run the entire block from an elevated PowerShell window. It registers a missing
service or safely updates an existing stopped service, fixes its working
directory, sets automatic startup, and explicitly restarts it five seconds
after any unexpected exit.

```powershell
$RepoRoot = 'C:\path\to\Network-Resource-Management-NRM-tool'
$ServiceName = 'NRMLocalAPI'
$Nssm = 'C:\Tools\nssm\nssm.exe'
$PowerShellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$Launcher = "$RepoRoot\scripts\windows\start-local-api.ps1"
$EnvFile = "$RepoRoot\scripts\windows\local-api.env"
$Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Launcher`" -EnvFile `"$EnvFile`""

$ExistingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $ExistingService) {
  & $Nssm install $ServiceName $PowerShellExe
} elseif ($ExistingService.Status -ne 'Stopped') {
  & $Nssm stop $ServiceName
}
& $Nssm set $ServiceName AppDirectory $RepoRoot
& $Nssm set $ServiceName AppParameters $Arguments
& $Nssm set $ServiceName DisplayName 'NRM Local API'
& $Nssm set $ServiceName Description 'Persistent local FastAPI gateway for NRM Ollama inference.'
& $Nssm set $ServiceName Start SERVICE_AUTO_START
& $Nssm set $ServiceName ObjectName LocalSystem
& $Nssm set $ServiceName AppExit Default Restart
& $Nssm set $ServiceName AppRestartDelay 5000
& $Nssm set $ServiceName AppThrottle 5000
& $Nssm set $ServiceName AppStopMethodConsole 10000
```

For a new service, `nssm install` should report that the service was installed.
For the service created during an earlier attempt, the block skips installation
and replaces its broken AppParameters in place. Each `nssm set` command should
report `Set parameter ... for service NRMLocalAPI`. Confirm the stored
configuration:

```powershell
& $Nssm get $ServiceName Application
& $Nssm get $ServiceName AppDirectory
& $Nssm get $ServiceName AppParameters
& $Nssm get $ServiceName Start
& $Nssm get $ServiceName AppExit Default
& $Nssm get $ServiceName AppRestartDelay
```

Expected values include the Windows PowerShell executable, the repository
root, both the launcher and absolute env-file paths, `SERVICE_AUTO_START`,
`Restart`, and `5000`.

## 6. Start, stop, restart, and check status

```powershell
$Nssm = 'C:\Tools\nssm\nssm.exe'
& $Nssm start NRMLocalAPI
& $Nssm status NRMLocalAPI
Get-Service -Name NRMLocalAPI
```

Expected status:

```text
SERVICE_RUNNING
Status  Name         DisplayName
------  ----         -----------
Running NRMLocalAPI  NRM Local API
```

Operational commands:

```powershell
& $Nssm stop NRMLocalAPI
& $Nssm start NRMLocalAPI
& $Nssm restart NRMLocalAPI
& $Nssm status NRMLocalAPI
```

Equivalent native checks:

```powershell
sc.exe query NRMLocalAPI
Get-CimInstance Win32_Service -Filter "Name='NRMLocalAPI'" |
  Select-Object Name, State, StartMode, StartName, ProcessId
```

Expected values are `STATE: 4 RUNNING`, `StartMode: Auto`, and `StartName:
LocalSystem`.

## 7. View logs

Follow the Uvicorn stdout and stderr logs in separate PowerShell windows:

```powershell
$RepoRoot = 'C:\path\to\Network-Resource-Management-NRM-tool'
$LatestStdout = Get-ChildItem "$RepoRoot\local-api\logs\nrm-local-api.*.stdout.log" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$LatestStderr = Get-ChildItem "$RepoRoot\local-api\logs\nrm-local-api.*.stderr.log" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content $LatestStdout.FullName -Tail 100 -Wait
Get-Content $LatestStderr.FullName -Tail 100 -Wait
```

Each launcher run gets timestamped stdout/stderr files, so a crash restart does
not erase the failure that triggered it. The service log records the exact pair
of files used for every run.

Read launcher lifecycle and configuration failures:

```powershell
Get-Content "$RepoRoot\local-api\logs\nrm-local-api.service.log" -Tail 100
```

Read NSSM service-wrapper events separately:

```powershell
Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'nssm' } `
  -MaxEvents 20 | Format-List TimeCreated, Id, LevelDisplayName, Message
```

## 8. Verify FastAPI on port 8000

```powershell
$RepoRoot = 'C:\path\to\Network-Resource-Management-NRM-tool'
$TokenLine = Select-String -Path "$RepoRoot\scripts\windows\local-api.env" `
  -Pattern '^NRM_INTERNAL_API_TOKEN=' | Select-Object -First 1
$Token = $TokenLine.Line.Substring($TokenLine.Line.IndexOf('=') + 1).Trim().Trim('"').Trim("'")
$Headers = @{ Authorization = "Bearer $Token" }

Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8000 -State Listen
Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -Headers $Headers
```

Expected: one listening connection on port 8000, followed by:

```text
status service       schema_version
------ -------       --------------
ok     nrm-local-api 1.0
```

## 9. Verify automatic restart after a crash

This intentionally kills only the process listening on port 8000. NSSM should
restart the PowerShell launcher and Uvicorn after the configured five-second
delay.

```powershell
$Before = (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8000 `
  -State Listen).OwningProcess
Stop-Process -Id $Before -Force
Start-Sleep -Seconds 10
$After = (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8000 `
  -State Listen).OwningProcess
"Before PID: $Before"
"After PID:  $After"
& 'C:\Tools\nssm\nssm.exe' status NRMLocalAPI
```

Expected: `After PID` is present and differs from `Before PID`; NSSM reports
`SERVICE_RUNNING`. Re-run the authenticated `/health` command from section 8
and expect the same `ok / nrm-local-api / 1.0` response.

## 10. Verify survival across a full reboot

First confirm automatic startup is registered:

```powershell
Get-CimInstance Win32_Service -Filter "Name='NRMLocalAPI'" |
  Select-Object Name, State, StartMode, StartName
```

Expected: `StartMode` is `Auto`. Then deliberately reboot the Windows server:

```powershell
Restart-Computer -Force
```

After the server is reachable again, open PowerShell; do not start FastAPI
manually. Run:

```powershell
Get-Service -Name NRMLocalAPI
& 'C:\Tools\nssm\nssm.exe' status NRMLocalAPI
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8000 -State Listen
```

Expected: Windows reports `Running`, NSSM reports `SERVICE_RUNNING`, and port
8000 has a listener. Finally rerun the authenticated `/health` command from
section 8 and confirm the same health JSON.

## 11. Updating application code later

Stop the service before changing the checkout or Python dependencies, then
restart it:

```powershell
& 'C:\Tools\nssm\nssm.exe' stop NRMLocalAPI
Set-Location 'C:\path\to\Network-Resource-Management-NRM-tool'
git pull origin main
& '.\local-api\.venv\Scripts\python.exe' -m pip install -r '.\local-api\requirements.txt'
& 'C:\Tools\nssm\nssm.exe' start NRMLocalAPI
```

## Official NSSM references

- Download and modern-Windows build guidance: https://www.nssm.cc/download
- Service installation and configuration: https://www.nssm.cc/usage
- Command-line management: https://www.nssm.cc/commands
