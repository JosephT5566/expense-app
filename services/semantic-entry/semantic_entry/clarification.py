"""Rule-selected questions: no extra model call, no persisted conversation state."""

from .contracts import JSON

QUESTIONS = {
    "amount": "這筆支出的台幣總金額是多少？請提供 1 到 9,999,999,999 元之間的整數。",
    "note": "這筆支出是買了什麼或支付什麼費用？",
    "date": "這筆支出實際發生在哪一天？請提供今天、昨天，或完整的年月日。",
    "payerId": "這筆支出由誰付款？個人支出只能記錄你自己的付款。",
    "members": "請明確提供付款人或分攤成員的姓名，需是目前允許記帳的成員。",
    "splitMemberIds": "這筆支出要由哪些成員平均分攤？請明確列出每一位；若是個人支出也請說明。",
    "categoryId": "這筆支出屬於哪個既有分類？也可以補充消費內容。",
    "currency": "目前只支援台幣支出。你能提供實際支付的台幣金額嗎？不能由我換算匯率。",
}


def contextual_question(field: str, context: JSON) -> str:
    question = QUESTIONS[field]
    if field == "date":
        baseline = context.get("referenceDate", context.get("today"))
        return (
            f"這筆支出實際發生在哪一天？本次「今天」固定為 {baseline}（台灣日期）；也可提供完整年月日。"
            if baseline
            else question
        )
    key = (
        "categories"
        if field == "categoryId"
        else "members"
        if field in ("payerId", "members", "splitMemberIds")
        else None
    )
    if key:
        names = []
        for item in context.get(key, []):
            name = " ".join(item["name"].split())
            if name and name not in names:
                names.append(name)
        if names:
            label = "可選分類" if key == "categories" else "可選成員"
            suffix = f" {label}（名稱）：" + "、".join(names)
            available = 300 - len(question)
            question += (
                suffix if len(suffix) <= available else suffix[: available - 1] + "…"
            )
    return question


def clarification_result(
    validation: JSON, request: JSON, context: JSON | None = None
) -> JSON:
    issues = validation["issues"]
    repairable = bool(issues) and all(
        i["field"] in QUESTIONS and i["code"] != "configuration" for i in issues
    )
    if repairable and len(request.get("history", [])) < 3:
        # Ask one focused question at a time; all issues still accompany the response.
        question = contextual_question(issues[0]["field"], context or {})
        return {
            "status": "needs_input",
            "requestId": request["requestId"],
            "question": question,
            "issues": issues,
        }
    return {"status": "rejected", "requestId": request["requestId"], "issues": issues}
