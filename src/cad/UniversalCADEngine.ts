export type CSGOperationType = 'UNION' | 'DIFFERENCE' | 'INTERSECTION';

export interface GeometricPrimitive {
  type: 'CUBE' | 'CYLINDER' | 'SPHERE' | 'POLYLINE';
  dimensions: number[];
  position?: [number, number, number];
  rotation?: [number, number, number];
}

export interface CSGNode {
  operation: CSGOperationType;
  children: (GeometricPrimitive | CSGNode)[];
}

export interface CADRenderResult {
  format: 'STL' | 'STEP' | 'SCAD' | 'SVG' | 'PNG';
  outputFilePath: string;
  metadata?: Record<string, any>;
}

export interface ICADExporter {
  targetFormat: string;
  compile(node: CSGNode | GeometricPrimitive): string;
  exportArtifact(node: CSGNode | GeometricPrimitive, outputPath: string): Promise<CADRenderResult>;
}

export class UniversalCADEngine {
  private exporters: Map<string, ICADExporter> = new Map();

  registerExporter(exporter: ICADExporter): void {
    this.exporters.set(exporter.targetFormat.toUpperCase(), exporter);
  }

  async generateArtifact(
    format: string,
    model: CSGNode | GeometricPrimitive,
    outputPath: string
  ): Promise<CADRenderResult> {
    const fmt = format.toUpperCase();
    const exporter = this.exporters.get(fmt);
    if (!exporter) {
      throw new Error(`No CAD exporter registered for target format: ${format}`);
    }
    return await exporter.exportArtifact(model, outputPath);
  }
}
