from urllib.parse import urlsplit

from app.schemas.workspace import GlobalNetworkConfig


class NetworkSettings:
    """Shared proxy policy; explicit service overrides never borrow global credentials."""

    def __init__(self, repository, secrets):
        self.repository, self.secrets = repository, secrets

    @staticmethod
    def validate(values):
        if values.get("network_mode") != "custom_proxy":
            return
        try:
            parts = urlsplit(values.get("proxy_url", "").strip())
            valid = (parts.scheme in {"http", "https"} and parts.hostname
                     and not (parts.username or parts.password or parts.query or parts.fragment)
                     and parts.path in {"", "/"})
            _ = parts.port
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("代理地址无效，请填写如 http://proxy.company.com:8080，账号密码须单独填写")

    def config(self):
        saved = self.repository.get_setting("global_network", {}) or {}
        defaults = GlobalNetworkConfig().model_dump(exclude={"proxy_password", "clear_proxy_password"})
        return {**defaults, **{k: saved[k] for k in defaults if k in saved},
                "has_proxy_password": bool(self.secrets.get(saved.get("proxy_password_ref")))}

    def save(self, values):
        values = GlobalNetworkConfig.model_validate(values).model_dump()
        self.validate(values)
        old = self.repository.get_setting("global_network", {}) or {}
        ref = old.get("proxy_password_ref")
        if values.pop("clear_proxy_password"):
            self.secrets.delete(ref)
            ref = None
        password = values.pop("proxy_password")
        if password:
            ref = self.secrets.set(password, ref)
        values.update(proxy_url=values["proxy_url"].strip(), proxy_password_ref=ref)
        self.repository.set_setting("global_network", values)
        return self.config()

    def resolve(self, local=None):
        local = local or {}
        inherited = not local.get("network_mode") or local["network_mode"] == "inherit"
        values = (self.repository.get_setting("global_network", {}) or {}) if inherited else local
        return {"network_mode": values.get("network_mode", "auto"), "proxy_url": values.get("proxy_url", ""),
                "proxy_username": values.get("proxy_username", ""),
                "proxy_password": values.get("proxy_password") or self.secrets.get(values.get("proxy_password_ref")),
                "scope": "全局设置" if inherited else "单独设置"}

    def migrate_inheritance(self):
        if self.repository.get_setting("network_inheritance_v1", False):
            return
        for key in ("mcp_search", "deepseek_web"):
            saved = self.repository.get_setting(key, {}) or {}
            if saved and saved.get("network_mode", "auto") == "auto":
                self.repository.set_setting(key, {**saved, "network_mode": "inherit"})
        for provider in self.repository.list_providers():
            extra = provider.get("extra") or {}
            if extra.get("network_mode", "auto") == "auto":
                self.repository.upsert_provider({**provider, "extra": {**extra, "network_mode": "inherit"}})
        self.repository.set_setting("network_inheritance_v1", True)
