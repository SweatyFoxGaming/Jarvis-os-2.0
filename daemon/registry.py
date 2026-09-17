import importlib
import pkgutil
import logging
from typing import Callable, Dict

log = logging.getLogger("jarvis.registry")

ACTION_HANDLERS: Dict[str, Callable] = {}

def ipc_action(name: str):
    """Decorator to register an IPC action handler."""
    def decorator(func: Callable):
        if name in ACTION_HANDLERS:
            log.warning(f"Overwriting handler for '{name}' with {func.__name__}")
        ACTION_HANDLERS[name] = func
        return func
    return decorator

def load_all_handlers(package):
    """Recursively scan and import all modules inside the specified package."""
    package_name = package.__name__
    package_path = package.__path__

    for _, module_name, _ in pkgutil.walk_packages(package_path, prefix=f"{package_name}."):
        try:
            importlib.import_module(module_name)
            log.info(f"Loaded handler module: {module_name}")
        except Exception as e:
            log.error(f"Failed to load handler module {module_name}: {e}")
