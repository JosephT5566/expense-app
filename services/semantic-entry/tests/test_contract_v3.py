"""Synthetic V3 acceptance/rejection vectors, shared with the browser parity runner."""

import hashlib
import json
from copy import deepcopy

import pytest
from conftest import REQUEST, REQUEST_ID, ROW

from semantic_entry.contracts import (
    DRAFT_CODES,
    DRAFT_FIELDS,
    load_json_v3,
    parse_draft_v3,
    parse_request,
    parse_request_v3,
    parse_response_v3,
    parse_status_response_v3,
    parse_stream_event_v3,
)
from semantic_entry.graph import input_hash, input_hash_v4

METADATA = {
    "model": "synthetic",
    "promptVersion": "v3",
    "inputTokens": None,
    "outputTokens": 0,
    "elapsedMs": 0,
}


def draft():
    values = dict(
        note="午餐🍜",
        amount=100,
        currency="TWD",
        date="2026-10-28",
        categoryId="food",
        scope="personal",
        payerEmail="a@example.test",
        splitMemberEmails=["a@example.test"],
    )
    result = {"draftId": REQUEST_ID}
    for key, value in values.items():
        result[key] = {
            "value": value,
            "state": "recognized",
            "confidence": 0.7,
            "source": "image",
        }
        if key == "date":
            result[key]["defaulted"] = None
    result.update(status="complete", issues=[])
    return result


def client_draft_variants():
    editable = {k: v for k, v in draft().items() if k not in ("status", "issues")}
    for patch in (
        {},
        {"status": "incomplete"},
        {"issues": [{"field": "note", "code": "missing"}]},
        {
            "status": "incomplete",
            "issues": [{"field": "note", "code": "missing"}],
            "updated": True,
        },
    ):
        yield {**deepcopy(editable), **patch}


def vectors():
    """Every invalid vector has an explicit expected rejection, not just parity."""
    result = []

    def add(name, kind, raw, invalid=False, event=None):
        result.append(
            dict(
                name=name,
                kind=kind,
                raw=raw,
                invalid=invalid,
                **({"event": event} if event else {}),
            )
        )

    analyze = {**REQUEST, "action": "analyze"}
    image = {
        "requestId": REQUEST_ID,
        "action": "analyze",
        "images": ["uploads/synthetic/a.png"],
    }
    revise = {**REQUEST, "action": "revise", "drafts": [draft()]}
    commit = {"requestId": REQUEST_ID, "action": "commit", "drafts": [draft()]}
    for request in (revise, commit):
        for index, d in enumerate(client_draft_variants()):
            add(
                f"client-computed-{request['action']}-{index}",
                "request",
                {**request, "drafts": [d]},
            )
        for key, value in (
            ("status", "invented"),
            ("issues", [{"field": "note", "code": "invented"}]),
            ("updated", 1),
            ("issues", "x"),
        ):
            add(
                f"bad-client-computed-{request['action']}-{key}",
                "request",
                {**request, "drafts": [{**draft(), key: value}]},
                True,
            )
    for name, raw in [
        ("text", analyze),
        ("image", image),
        ("revise", revise),
        ("commit", commit),
    ]:
        add(name, "request", raw)
        add(name + "-extra", "request", {**raw, "extra": True}, True)
    for action in ("analyze", "revise", "commit", "invented", None):
        for field, value in [
            ("text", "補充"),
            ("history", []),
            ("images", ["uploads/synthetic/a.png"]),
            ("drafts", [draft()]),
        ]:
            base = deepcopy(
                {"analyze": analyze, "revise": revise, "commit": commit}.get(
                    action, analyze
                )
            )
            base["action"] = action
            base[field] = value
            invalid = (
                action not in ("analyze", "revise", "commit")
                or (action == "analyze" and field in ("images", "drafts"))
                or (action == "revise" and field == "images")
                or (action == "commit" and field != "drafts")
            )
            # Image analyze cannot carry history, including an empty history.
            if action == "analyze" and field == "images":
                invalid = False
            add(f"action-{action}-{field}", "request", base, invalid)
    for raw in [
        {**analyze, "action": "invented"},
        {"requestId": REQUEST_ID, "action": "analyze"},
        {**analyze, "text": " "},
        {**revise, "text": ""},
        {**image, "history": []},
        {**image, "images": [{"path": "uploads/synthetic/a.png", "generation": "1"}]},
    ]:
        add("bad-combination", "request", raw, True)
    for raw in (analyze, revise, commit, image):
        for key in raw:
            missing = {k: v for k, v in raw.items() if k != key}
            add(
                "required-request-key",
                "request",
                missing,
                key != "text" or "images" not in raw,
            )
    for value in (None, ["analyze"], 3, True, {}):
        add("strict-action-type", "request", {**analyze, "action": value}, True)
    for history, invalid in [
        ([], False),
        ([{"question": " \ufeff金額？ ", "answer": " e\u0301 "}], False),
        ([{"question": "q", "answer": "a"}] * 3, False),
        ([{"question": "q", "answer": "a"}] * 4, True),
        ([{"question": "q", "answer": "a", "extra": 1}], True),
        ([{"question": "q", "answer": "\ud800"}], True),
        (None, True),
    ]:
        add("history", "request", {**revise, "history": history}, invalid)
    for date, invalid in [
        ("0100-01-01", False),
        ("2000-02-29", False),
        ("0099-12-31", True),
        ("2026-02-29", True),
        (None, True),
    ]:
        add("reference-date", "request", {**commit, "referenceDate": date}, invalid)
    for text in ("", " \ufeff ", "é", "e\u0301", "🍜" * 500):
        add("image-text", "request", {**image, "text": text})
    for text in (None, True, "🍜" * 501, "\ud800"):
        add("bad-image-text", "request", {**image, "text": text}, True)
    for paths, invalid in [
        ([], True),
        (["a"] * 4, False),
        (["a"] * 5, True),
        ([""], True),
        ([".."], True),
        (["a/../b"], True),
        ([" a"], True),
        (["a" * 1024], False),
        (["a" * 1025], True),
        ([None], True),
    ]:
        add("paths", "request", {**image, "images": paths}, invalid)
    for count in (0, 1, 20, 21):
        add(
            f"draft-count-{count}",
            "request",
            {**commit, "drafts": [draft()] * count},
            count not in (1, 20),
        )
    for key in draft():
        d = draft()
        del d[key]
        add("required-draft-key", "draft", d, True)
    for field in ("state", "source"):
        d = draft()
        d["note"][field] = [d["note"][field]]
        add("strict-field-type", "draft", d, True)
    for key in ("value", "state", "source"):
        d = draft()
        del d["note"][key]
        add("required-field-key", "draft", d, True)
    for value in (0, -1, 1.5, True, 2**53, "100"):
        d = draft()
        d["amount"]["value"] = value
        add("bad-amount", "draft", d, True)
    for value in (1, 2**53 - 1):
        d = draft()
        d["amount"]["value"] = value
        add("safe-amount", "draft", d)
    for value in (
        0,
        0.699999,
        0.7,
        1,
        1.0,
        -0.0,
        1e-7,
        1e-6,
        1.2345678901234567e-7,
        5e-324,
        None,
        -0.1,
        1.1,
        True,
        "0.7",
    ):
        d = draft()
        d["amount"]["confidence"] = value
        add(
            "confidence",
            "draft",
            d,
            value is True
            or isinstance(value, str)
            or (value is not None and (value < 0 or value > 1)),
        )
        if (
            value is not True
            and not isinstance(value, str)
            and (value is None or 0 <= value <= 1)
        ):
            add("confidence-hash", "request", {**commit, "drafts": [d]})
    for state in ("recognized", "unrecognized", "missing", "explicit_null"):
        for source in ("image", "text", "default", "user"):
            d = draft()
            d["note"].update(value=None, state=state, source=source, confidence=None)
            add("nullable-states-sources", "draft", d)
    for defaulted in (None, "unreadable", "future", "invented"):
        d = draft()
        d["date"]["defaulted"] = defaulted
        add("date-default", "draft", d, defaulted == "invented")
    for key, patch in [
        ("note", {"value": "x" * 201}),
        ("note", {"extra": 1}),
        ("note", {"state": "invented"}),
        ("note", {"source": "invented"}),
        ("note", {"state": "explicit_null"}),
        ("date", {"value": "2026-02-29"}),
        ("currency", {"value": "twd"}),
        ("scope", {"value": "other"}),
        ("payerEmail", {"value": "bad"}),
        ("splitMemberEmails", {"value": ["bad"]}),
    ]:
        d = draft()
        d[key].update(patch)
        add("bad-draft-field", "draft", d, True)
    for key in DRAFT_FIELDS:
        d = draft()
        del d[key]["confidence"]
        add("required-confidence-key", "draft", d, True)
    d = draft()
    d.update(
        mergedFrom=[REQUEST_ID],
        originalAmount={"text": "99.01", "currency": "USD"},
        updated=True,
    )
    d["currency"]["value"] = "USD"
    add("review-provenance", "draft", d)
    add("review-provenance-hash", "request", {**commit, "drafts": [d]})
    for patch in (
        {"extra": True},
        {"status": "invented"},
        {"updated": 1},
        {"mergedFrom": ["bad"]},
        {"originalAmount": {"text": "1", "currency": "TWD", "extra": 1}},
    ):
        add("bad-draft", "draft", {**draft(), **patch}, True)
    created = dict(
        status="created",
        requestId=REQUEST_ID,
        expenses=[ROW],
        replayed=False,
        metadata=METADATA,
    )
    drafts = dict(
        status="drafts",
        requestId=REQUEST_ID,
        drafts=[draft()],
        reason="incomplete",
        metadata=METADATA,
    )
    for key in ("status", "issues"):
        missing = {k: v for k, v in draft().items() if k != key}
        body = {**drafts, "drafts": [missing]}
        add(f"response-draft-missing-{key}", "response", body, True)
        add(f"result-draft-missing-{key}", "stream", body, True, "result")
    rejected = dict(
        status="rejected",
        requestId=REQUEST_ID,
        issues=[{"field": "drafts", "code": "invalid"}],
        draftIssues=[
            {
                "draftId": REQUEST_ID,
                "issues": [{"field": "note", "code": "missing_confidence"}],
            }
        ],
    )
    needs = dict(
        status="needs_input",
        requestId=REQUEST_ID,
        question="金額？",
        issues=[{"field": "amount", "code": "missing"}],
    )
    for response in (
        created,
        {**created, "metadata": None},
        drafts,
        {**drafts, "reason": "multiple"},
        rejected,
        needs,
        {
            "status": "rejected",
            "requestId": REQUEST_ID,
            "issues": [{"field": "images", "code": "not_a_receipt"}],
        },
    ):
        add("response", "response", response)
        add("result-event", "stream", response, event="result")
    for code in DRAFT_CODES:
        d = draft()
        d.update(status="incomplete", issues=[{"field": "note", "code": code}])
        add("draft-issue-code", "draft", d)
    for response in (
        {**created, "expenses": []},
        {**created, "expenses": [ROW] * 21},
        {**created, "expense": ROW},
        {k: v for k, v in created.items() if k != "expenses"},
        {**created, "metadata": {}},
        {**drafts, "metadata": None},
        {**drafts, "reason": "other"},
        {**drafts, "drafts": []},
        {**rejected, "draftIssues": [{"draftId": "bad", "issues": []}]},
        {**rejected, "issues": []},
    ):
        add("bad-response", "response", response, True)
        add("bad-result-event", "stream", response, True, "result")
    completed = dict(
        status="completed", requestId=REQUEST_ID, expenses=[ROW], replayed=True
    )
    for body, invalid in [
        (completed, False),
        ({"status": "not_found", "requestId": REQUEST_ID}, False),
        ({**completed, "replayed": False}, True),
        ({**completed, "expenses": []}, True),
        ({**completed, "expense": ROW}, True),
    ]:
        add("status", "status", body, invalid)
    for event, body, invalid in [
        (
            "analysis_delta",
            {"requestId": REQUEST_ID, "seq": 0, "text": "🍜" * 200},
            False,
        ),
        ("analysis_delta", {"requestId": REQUEST_ID, "seq": -1, "text": "a"}, True),
        (
            "analysis_delta",
            {"requestId": REQUEST_ID, "seq": 0, "text": "🍜" * 201},
            True,
        ),
        ("persisting", {"status": "persisting", "requestId": REQUEST_ID}, False),
        ("error", {"error": {"code": "image_changed", "uncertain": False}}, False),
        ("error", {"error": {"code": "x", "uncertain": 0}}, True),
        ("invented", {}, True),
    ]:
        add("stream", "stream", body, invalid, event)
    return result


PARSERS = {
    "request": parse_request_v3,
    "draft": parse_draft_v3,
    "response": parse_response_v3,
    "status": parse_status_response_v3,
}


def parse_vector(case):
    return (
        parse_stream_event_v3(case["event"], case["raw"])
        if case["kind"] == "stream"
        else PARSERS[case["kind"]](case["raw"])
    )


def export_v3():
    cases = deepcopy(vectors())
    for case in cases:
        if case["invalid"]:
            try:
                parse_vector(case)
            except ValueError:
                continue
            raise AssertionError(case["name"])
        case["parsed"] = parse_vector(case)
        if case["kind"] == "request":
            images = [
                {"path": path, "generation": "9007199254740993"}
                for path in case["parsed"].get("images", [])
            ]
            case["images"] = images
            case["hash"] = input_hash_v4(case["parsed"], images)
    return cases


@pytest.mark.parametrize("case", vectors(), ids=lambda c: c["name"])
def test_v3_contract_vectors(case):
    if case["invalid"]:
        with pytest.raises(ValueError):
            parse_vector(case)
    else:
        parsed = parse_vector(case)
        assert parsed is not None
        if case["kind"] == "request":
            for d in parsed.get("drafts", []):
                assert not {"status", "issues", "updated"}.intersection(d)


@pytest.mark.parametrize("action", ["revise", "commit"])
def test_v3_client_draft_variants_normalize_and_hash_identically(action):
    requests = [
        {
            "requestId": REQUEST_ID,
            "action": action,
            "drafts": [d],
            **({"text": "補充"} if action == "revise" else {}),
        }
        for d in client_draft_variants()
    ]
    normalized = parse_request_v3(requests[0])
    for request in requests:
        assert parse_request_v3(request) == normalized
        assert input_hash_v4(request) == input_hash_v4(requests[0])


def test_v3_v2_isolation_and_legacy_hashes():
    for case in vectors():
        if case["kind"] == "request" and not case["invalid"]:
            with pytest.raises(ValueError):
                parse_request(case["raw"])
    for request in (
        REQUEST,
        {**REQUEST, "history": [{"question": "q", "answer": "a"}]},
        {**REQUEST, "referenceDate": "2026-10-28"},
    ):
        assert input_hash_v4({**request, "action": "analyze"}) == input_hash(request)


def test_v4_hash_canonical_editable_fields_and_generations():
    request = {"requestId": REQUEST_ID, "action": "commit", "drafts": [draft()]}
    original = input_hash_v4(request)
    d = request["drafts"][0]
    d.update(
        status="incomplete", issues=[{"field": "note", "code": "missing"}], updated=True
    )
    assert input_hash_v4(request) == original
    request["drafts"][0] = dict(reversed(list(d.items())))
    assert input_hash_v4(request) == original
    for key in DRAFT_FIELDS:
        modified = deepcopy(request)
        modified["drafts"][0][key]["source"] = "user"
        assert input_hash_v4(modified) != original
    image = {
        "requestId": REQUEST_ID,
        "action": "analyze",
        "images": ["uploads/synthetic/a"],
    }
    with pytest.raises(ValueError):
        input_hash_v4(image)
    for metadata in (
        [{"path": "wrong", "generation": "1"}],
        [{"path": image["images"][0], "generation": 1}],
        [{"path": image["images"][0], "generation": ""}],
    ):
        with pytest.raises(ValueError):
            input_hash_v4(image, metadata)
    one = [{"path": image["images"][0], "generation": "1"}]
    two = [{**one[0], "generation": "2"}]
    assert input_hash_v4(image, one) != input_hash_v4(image, two)
    payload = dict(
        action="analyze", text="", history=[], referenceDate=None, images=one, drafts=[]
    )
    expected = hashlib.sha256(
        (
            "v4\n" + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        ).encode()
    ).hexdigest()
    assert input_hash_v4(image, one) == expected


JSON_INVALID = [
    '{"action":"analyze","action":"commit"}',
    '{"drafts":[{"amount":1,"amount":2}]}',
    '{"x":NaN}',
    '{"x":Infinity}',
    '{"x":1e400}',
    '{"x":1,"\\u0078":2}',
]


@pytest.mark.parametrize("text", JSON_INVALID)
def test_v3_json_rejects_duplicate_keys_and_nonfinite(text):
    with pytest.raises(ValueError):
        load_json_v3(text)


def test_v3_nonfinite_values_rejected_before_serialization():
    for number in (float("nan"), float("inf"), -float("inf")):
        for key in ("amount", "note"):
            d = draft()
            d[key]["value"] = number
            with pytest.raises(ValueError):
                parse_draft_v3(d)
        d = draft()
        d["note"]["confidence"] = number
        with pytest.raises(ValueError):
            parse_draft_v3(d)


def test_v3_field_states_and_confidence_are_preserved_not_gated():
    for state in ("recognized", "unrecognized", "missing", "explicit_null"):
        for confidence in (None, 0.699999, 0.7):
            d = draft()
            d["note"].update(state=state, value=None, confidence=confidence)
            assert parse_draft_v3(d)["note"] == d["note"]
    for defaulted in ("future", "unreadable"):
        d = draft()
        d["date"]["defaulted"] = defaulted
        assert parse_draft_v3(d)["date"]["defaulted"] == defaulted


def test_v3_created_always_expenses_array():
    for count in (1, 20):
        body = dict(
            status="created",
            requestId=REQUEST_ID,
            expenses=[ROW] * count,
            replayed=False,
            metadata=None,
        )
        assert len(parse_response_v3(body)["expenses"]) == count
    with pytest.raises(ValueError):
        parse_response_v3(
            dict(
                status="created",
                requestId=REQUEST_ID,
                expense=ROW,
                replayed=False,
                metadata=None,
            )
        )
