"""Static regression checks for the Windows service launcher contract.

These checks run on any development host. The real powershell.exe invocation
remains a documented Windows-side verification step.
"""

from pathlib import Path
import re
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
LAUNCHER = REPO_ROOT / "scripts" / "windows" / "start-local-api.ps1"
RUNBOOK = REPO_ROOT / "docs" / "windows-service-setup.md"


class WindowsLauncherContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = LAUNCHER.read_text(encoding="utf-8")
        cls.runbook = RUNBOOK.read_text(encoding="utf-8")

    def test_env_file_default_has_no_invocation_context_expression(self) -> None:
        param_end = self.launcher.index("\n)\n") + 3
        param_block = self.launcher[:param_end]

        self.assertRegex(
            param_block,
            re.compile(r"\[string\]\$EnvFile\s*=\s*''"),
        )
        self.assertNotIn("$PSScriptRoot", param_block)
        self.assertNotIn("$MyInvocation", param_block)
        self.assertNotIn("Join-Path", param_block)

    def test_script_path_and_default_env_are_resolved_in_body(self) -> None:
        self.assertNotIn("$PSScriptRoot", self.launcher)
        self.assertIn("$ScriptPath = $MyInvocation.MyCommand.Path", self.launcher)
        self.assertIn("$ScriptPath = $PSCommandPath", self.launcher)
        self.assertIn("$ScriptDirectory = Split-Path -Parent $ScriptPath", self.launcher)
        self.assertIn(
            "$EnvFile = Join-Path $ScriptDirectory 'local-api.env'",
            self.launcher,
        )
        self.assertIn(
            "$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDirectory '..\\..'))",
            self.launcher,
        )

    def test_nssm_passes_absolute_env_file_and_manual_check_omits_it(self) -> None:
        self.assertIn(
            '$EnvFile = "$RepoRoot\\scripts\\windows\\local-api.env"',
            self.runbook,
        )
        self.assertIn('-File `"$Launcher`" -EnvFile `"$EnvFile`"', self.runbook)
        self.assertIn(
            "Get-Service -Name $ServiceName -ErrorAction SilentlyContinue",
            self.runbook,
        )

        manual_invocation = re.search(
            r"& powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `\n"
            r"\s+-File \"\$RepoRoot\\scripts\\windows\\start-local-api\.ps1\"",
            self.runbook,
        )
        self.assertIsNotNone(manual_invocation)
        self.assertNotIn("-EnvFile", manual_invocation.group(0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
