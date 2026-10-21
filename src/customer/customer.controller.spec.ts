import { readFileSync } from "fs"
import { join } from "path"

const controllerSource = readFileSync(join(__dirname, "customer.controller.ts"), "utf8")

function decoratorIndex(decorator: string): number {
  return controllerSource.indexOf(decorator)
}

describe("CustomerController route order", () => {
  it("keeps single-segment static GET routes before customer id route", () => {
    const customerDetailIndex = decoratorIndex('@Get(":id")')

    expect(customerDetailIndex).toBeGreaterThanOrEqual(0)

    for (const decorator of [
      '@Get("public-avatars")',
      '@Get("public-voices")',
      '@Get("storyboards")',
      '@Get("materials")',
    ]) {
      const routeIndex = decoratorIndex(decorator)
      expect(routeIndex).toBeGreaterThanOrEqual(0)
      expect(routeIndex).toBeLessThan(customerDetailIndex)
    }
  })
})
