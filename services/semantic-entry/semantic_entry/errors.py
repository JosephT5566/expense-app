class SemanticError(Exception):
    def __init__(self, status: int, code: str, uncertain: bool = False):
        super().__init__(code)
        self.status = status
        self.code = code
        self.uncertain = uncertain
