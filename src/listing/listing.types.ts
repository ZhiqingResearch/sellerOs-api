export interface ListingDocumentFacts {
  productName: string
  brand: string
  category: string
  materials: string[]
  dimensions: Record<string, string>
  features: string[]
  sellingPoints: string[]
  targetAudience: string[]
  usageScenarios: string[]
  certifications: string[]
  warnings: string[]
}
