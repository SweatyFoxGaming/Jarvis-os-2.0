import logging
from typing import Dict, Any, List

logger = logging.getLogger(__name__)


class InfrastructureHealth:
    """
    Centralised health monitoring for all subsystems.
    """

    def __init__(self):
        self.checks: Dict[str, callable] = {}

    def register_check(self, name: str, check_func: callable) -> None:
        self.checks[name] = check_func

    def run_checks(self) -> Dict[str, Any]:
        results = {}
        for name, func in self.checks.items():
            try:
                results[name] = func()
            except Exception as e:
                results[name] = {"status": "error", "error": str(e)}
        return results
