import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface StorageProvider {
  upload(key: string, data: Buffer, contentType: string): Promise<string>
  delete(key: string): Promise<void>
  getPublicUrl(key: string): string
}

export function createStorage(): StorageProvider {
  const provider = process.env.STORAGE_PROVIDER || 'local'
  switch (provider) {
    case 'local':
      return new LocalStorage()
    default:
      return new LocalStorage()
  }
}

class LocalStorage implements StorageProvider {
  private basePath: string
  private baseUrl: string

  constructor() {
    this.basePath = process.env.LOCAL_STORAGE_PATH || './uploads'
    this.baseUrl = (process.env.PUBLIC_URL || 'http://localhost:3010') + '/uploads'
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true })
    }
  }

  async upload(key: string, data: Buffer, contentType: string): Promise<string> {
    const dir = dirname(join(this.basePath, key))
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(join(this.basePath, key), data)
    return this.getPublicUrl(key)
  }

  async delete(key: string): Promise<void> {
    const filePath = join(this.basePath, key)
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
  }

  getPublicUrl(key: string): string {
    return `${this.baseUrl}/${key}`
  }
}
