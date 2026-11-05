import { Injectable } from "@nestjs/common"
import { SpacesService } from "../spaces/spaces.service"

@Injectable()
export class OssService {
  constructor(private readonly storage: SpacesService) {}
  uploadBuffer(...args: Parameters<SpacesService["uploadBuffer"]>) {
    return this.storage.uploadBuffer(...args)
  }
  uploadStream(...args: Parameters<SpacesService["uploadStream"]>) {
    return this.storage.uploadStream(...args)
  }
  generateOSSPolicy() {
    return this.storage.generateOSSPolicy()
  }
}
