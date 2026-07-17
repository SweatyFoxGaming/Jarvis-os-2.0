"""
Tests for my_new_plugin plugin.
"""

import unittest

class Testmy_new_plugin(unittest.TestCase):
    def test_health(self):
        from my_new_plugin import health
        self.assertTrue(health())

if __name__ == "__main__":
    unittest.main()
