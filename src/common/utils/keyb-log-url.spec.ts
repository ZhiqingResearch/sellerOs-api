import { keybSafeLogUrl } from "./keyb-log-url"

describe("KeyB HTTP log URL", () => {
  it.each([
    ["/api/skills/keys?key=private-value", "/api/skills/keys"],
    ["/api/skills/keys/reveal?token=private-value", "/api/skills/keys/reveal"],
    ["/api/open/keyb/credit/deduct?key=private-value", "/api/open/keyb/credit/deduct"],
    ["/api/skills/keys/private-value", "/api/skills/keys"],
    ["/api/unrelated?query=retained", "/api/unrelated?query=retained"],
  ])("sanitizes only credential endpoints: %s", (url, expected) => {
    expect(keybSafeLogUrl(url)).toBe(expected)
  })
})
