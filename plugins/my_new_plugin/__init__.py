"""
my_new_plugin plugin for Jarvis OS.
"""

import logging

logger = logging.getLogger(__name__)

def initialize():
    """Called when the plugin is activated."""
    logger.info(f"my_new_plugin plugin initialized.")

def shutdown():
    """Called when the plugin is deactivated."""
    logger.info(f"my_new_plugin plugin shutting down.")

def health() -> bool:
    """Return True if healthy."""
    return True

def example(params=None):
    """Example capability."""
    return {"message": "Hello from my_new_plugin!"}
