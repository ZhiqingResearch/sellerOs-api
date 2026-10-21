import { ArgumentsHost, BadRequestException, ConflictException } from "@nestjs/common"
import { Logger as WinstonLogger } from "winston"
import { AllExceptionsFilter } from "./http-exception.filter"

describe("AllExceptionsFilter", () => {
  it("does not expose KeyB endpoint query values or JSON parser request excerpts", () => {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const logger = { warn: jest.fn(), error: jest.fn() }
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ method: "POST", url: "/api/skills/keys?key=private-query-value" }),
      }),
    } as unknown as ArgumentsHost
    const filter = new AllExceptionsFilter(logger as unknown as WinstonLogger)
    filter.catch(new BadRequestException('Unexpected token in JSON "private-body-value"'), host)
    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "请求 JSON 格式不正确" })
    )
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(
      /private-query-value|private-body-value/
    )
    filter.catch(new Error("private-internal-value"), host)
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private-internal-value")
  })

  it("preserves business code and details from HttpException", () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    }
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ method: "PUT", url: "/api/test" }),
      }),
    } as unknown as ArgumentsHost
    const logger = { warn: jest.fn(), error: jest.fn() } as unknown as WinstonLogger
    const filter = new AllExceptionsFilter(logger)

    filter.catch(
      new ConflictException({
        code: "ANALYSIS_VERSION_CONFLICT",
        message: "版本冲突",
        details: { currentVersion: 4 },
      }),
      host
    )

    expect(response.status).toHaveBeenCalledWith(409)
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 409,
        code: "ANALYSIS_VERSION_CONFLICT",
        message: "版本冲突",
        details: { currentVersion: 4 },
      })
    )
  })
})
