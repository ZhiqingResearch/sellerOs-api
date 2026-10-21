import { canonicalJson, hashJson } from "./canonical-json"

describe("canonicalJson", () => {
  it("sorts object keys recursively and keeps array order", () => {
    const left = { z: 1, nested: { b: true, a: "x" }, list: [2, 1] }
    const right = { list: [2, 1], nested: { a: "x", b: true }, z: 1 }

    expect(canonicalJson(left)).toBe(canonicalJson(right))
    expect(hashJson(left)).toBe(hashJson(right))
    expect(hashJson({ list: [1, 2] })).not.toBe(hashJson({ list: [2, 1] }))
  })

  it("rejects values that are not valid JSON", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow(TypeError)
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError)
  })
})
