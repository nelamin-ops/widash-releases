import json
from pathlib import Path
import pytest

FIXTURES = Path(__file__).parent / "fixtures"

@pytest.fixture
def report_response():
    return json.loads((FIXTURES / "report_response.json").read_text())

@pytest.fixture
def activity_response():
    return json.loads((FIXTURES / "activity_response.json").read_text())
