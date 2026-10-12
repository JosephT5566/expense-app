import json
import time
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE = "http://127.0.0.1:55808"
REQUEST_ID = "12345678-1234-4123-8123-123456789abc"


def call(path, body=None, auth=True):
    headers = {"Authorization": "Bearer synthetic"} if auth else {}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
    )
    try:
        with urlopen(request, timeout=3) as response:
            return response.status, json.load(response)
    except HTTPError as e:
        return e.code, json.load(e)


for _ in range(30):
    try:
        if call("/healthz")[0] == 200:
            break
    except (URLError, OSError, HTTPException):
        pass
    time.sleep(1)
assert call("/healthz")[0] == 200
body = {"requestId": REQUEST_ID, "text": "synthetic lunch 100"}
assert call("/semantic-entry", body, False)[0] == 401
assert call("/semantic-entry", {**body, "userId": "a"})[0] == 400
status, result = call("/semantic-entry", body)
assert status == 200 and result["status"] == "created"
status, result = call(f"/semantic-entry/{REQUEST_ID}")
assert status == 200 and result["status"] == "not_found"
print(
    "Container smoke: healthz200, missing-token401, extra-field400, mock-created200, GET not_found200"
)
