import sys
sys.path.insert(0, ".")
from src.llm_engine import LLMEngine
engine = LLMEngine()
print(f"Model loaded: {engine.llm is not None}")
if engine.llm:
    response = engine.generate("Hello, who are you?", max_tokens=50)
    print(f"Response: {response[:200]}")
