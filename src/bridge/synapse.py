import os
import subprocess
import shlex
import logging
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


class SynapseInterface:
    """
    The exclusive, deterministic gateway to Phoenix OS internals.
    All file I/O and command execution passes through this interface.
    """

    def __init__(self, security_module, secure_memory=None, secure_runner=None):
        if security_module is None:
            raise ValueError("security_module cannot be None")
        self._security = security_module
        self._secure_memory = secure_memory
        self._secure_runner = secure_runner

        # Freeze the security policy to prevent runtime changes
        self._security.policy.freeze()
        logger.info("[SynapseInterface] Security policy frozen. Gateway is immutable.")

        # Store copies of allowed paths/commands for fast access (read-only)
        self._allowed_paths = self._security.policy.allowed_paths
        self._allowed_commands = self._security.policy.allowed_commands
        logger.info(f"[SynapseInterface] Allowed paths: {len(self._allowed_paths)}")
        logger.info(f"[SynapseInterface] Allowed commands: {self._allowed_commands}")

    def _audit_log(self, action: str, resource: str, status: str, details: Optional[Dict[str, Any]] = None):
        self._security.audit_log(action, resource, status)
        if self._secure_memory is not None:
            try:
                self._secure_memory.insert(
                    text=f"SYNAPSE: {action} on {resource} - {status}",
                    metadata={
                        "type": "synapse_audit",
                        "action": action,
                        "resource": resource,
                        "status": status,
                        "details": details or {},
                    },
                )
            except Exception as e:
                logger.warning(f"[SynapseInterface] Failed to audit log: {e}")

    # ---------- Helpers for chained commands ----------
    def _is_shell_chained(self, command: str) -> bool:
        """Check if the command contains shell operators that require a shell."""
        operators = ['&&', '||', '|', ';', '&', '>', '<', '>>']
        return any(op in command for op in operators)

    def _extract_base_command(self, command: str) -> str:
        """Extract the first token before any shell operator."""
        operators = ['&&', '||', '|', ';', '&', '>', '<', '>>']
        for op in operators:
            if op in command:
                base = command.split(op)[0].strip()
                return base.split()[0] if base else ""
        # No operator, return first token
        return command.split()[0] if command else ""

    # ---------- Core methods ----------
    def read_file(self, path: str) -> Optional[str]:
        if not path:
            logger.warning("[SynapseInterface] read_file called with empty path.")
            return None

        if not self._security.validate_path(path):
            logger.warning(f"[SynapseInterface] Read denied for path: {path}")
            self._audit_log("read_file", path, "DENIED")
            return None

        self._audit_log("read_file", path, "APPROVED")
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
            logger.debug(f"[SynapseInterface] Read {len(content)} bytes from {path}")
            return content
        except FileNotFoundError:
            logger.error(f"[SynapseInterface] File not found: {path}")
            self._audit_log("read_file", path, "FAILED", {"error": "file_not_found"})
            return None
        except PermissionError:
            logger.error(f"[SynapseInterface] Permission denied reading: {path}")
            self._audit_log("read_file", path, "FAILED", {"error": "permission_denied"})
            return None
        except Exception as e:
            logger.error(f"[SynapseInterface] Read error on {path}: {e}", exc_info=True)
            self._audit_log("read_file", path, "FAILED", {"error": str(e)})
            return None

    def write_file(self, path: str, content: str) -> bool:
        if not path:
            logger.warning("[SynapseInterface] write_file called with empty path.")
            return False

        if not self._security.validate_path(path):
            logger.warning(f"[SynapseInterface] Write denied for path: {path}")
            self._audit_log("write_file", path, "DENIED")
            return False

        self._audit_log("write_file", path, "APPROVED", {"size": len(content)})
        try:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(content)
            logger.debug(f"[SynapseInterface] Wrote {len(content)} bytes to {path}")
            self._audit_log("write_file", path, "SUCCESS", {"size": len(content)})
            return True
        except PermissionError:
            logger.error(f"[SynapseInterface] Permission denied writing: {path}")
            self._audit_log("write_file", path, "FAILED", {"error": "permission_denied"})
            return False
        except Exception as e:
            logger.error(f"[SynapseInterface] Write error on {path}: {e}", exc_info=True)
            self._audit_log("write_file", path, "FAILED", {"error": str(e)})
            return False

    def execute_command(self, command: str, timeout: int = 30) -> str:
        """Execute a system command, supporting chained commands."""
        if not command:
            return "Error: No command provided."

        # Validate the command using the security module (now supports chained)
        if not self._security.validate_command(command):
            logger.warning(f"[SynapseInterface] Command denied: {command}")
            self._audit_log("execute_command", command, "DENIED")
            return "Security Denial: Command not allowed."

        self._audit_log("execute_command", command, "APPROVED")

        # Detect if we need a shell for chained commands
        use_shell = self._is_shell_chained(command)

        try:
            if self._secure_runner is not None:
                # If secure_runner is available, use it (assumes list args)
                args = shlex.split(command)
                result = self._secure_runner.run_safe(args, timeout=timeout)
                self._audit_log("execute_command", command, "SUCCESS", {"output_preview": result[:200]})
                return result

            # Fallback: subprocess
            if use_shell:
                # Verify that the base command is allowed (additional safety)
                base_cmd = self._extract_base_command(command)
                if base_cmd not in self._allowed_commands:
                    self._audit_log("execute_command", command, "DENIED_BY_RUNTIME_CHECK")
                    return f"Security Denial: Command '{base_cmd}' not allowed in chained shell."
                # Run with shell=True
                result = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    shell=True,
                    timeout=timeout,
                )
            else:
                # Original shell=False path
                args = shlex.split(command)
                if args[0] not in self._allowed_commands:
                    self._audit_log("execute_command", command, "DENIED_BY_RUNTIME_CHECK")
                    return "Security Denial: Command base not allowed."
                result = subprocess.run(
                    args,
                    capture_output=True,
                    text=True,
                    shell=False,
                    timeout=timeout,
                )

            output = result.stdout + result.stderr
            if result.returncode != 0:
                logger.warning(f"[SynapseInterface] Command '{command}' exited with code {result.returncode}")
                self._audit_log("execute_command", command, "FAILED", {"returncode": result.returncode})
                return f"Command failed (code {result.returncode}): {output.strip()}"
            self._audit_log("execute_command", command, "SUCCESS", {"output_preview": output[:200]})
            return output.strip()
        except subprocess.TimeoutExpired:
            logger.error(f"[SynapseInterface] Command '{command}' timed out after {timeout}s")
            self._audit_log("execute_command", command, "FAILED", {"error": "timeout"})
            return f"Error: Command timed out after {timeout} seconds."
        except Exception as e:
            logger.error(f"[SynapseInterface] Command execution error: {e}", exc_info=True)
            self._audit_log("execute_command", command, "FAILED", {"error": str(e)})
            return f"Error executing command: {e}"

    def shutdown(self):
        logger.info("[SynapseInterface] Shutting down.")
        if self._secure_memory and hasattr(self._secure_memory, 'close'):
            try:
                self._secure_memory.close()
            except Exception as e:
                logger.warning(f"[SynapseInterface] Error closing secure memory: {e}")
        self._secure_memory = None
        self._secure_runner = None
