import { OpenSCADExporter } from './OpenSCADExporter.js';

export interface CSGNode {
  operation?: 'UNION' | 'DIFFERENCE' | 'INTERSECTION';
  children?: CSGNode[];
  type?: 'CUBE' | 'CYLINDER' | 'SPHERE';
  dimensions?: number[];
}

export interface CADRenderResult {
  format: string;
  outputFilePath: string;
  rawContent: string;
}

export interface ICADExporter {
  format: string;
  export(node: CSGNode, outputPath: string): Promise<CADRenderResult>;
}

export class UniversalCADEngine {
  private exporters: Map<string, ICADExporter> = new Map();

  constructor() {
    this.registerExporter(new OpenSCADExporter());
  }

  public registerExporter(exporter: ICADExporter): void {
    this.exporters.set(exporter.format.toUpperCase(), exporter);
  }

  public async generateArtifact(format: string, model: CSGNode, outputPath: string): Promise<CADRenderResult> {
    const fmt = format.toUpperCase();
    const exporter = this.exporters.get(fmt);
    if (!exporter) {
      throw new Error(`Unsupported CAD export format: ${format}. Registered formats: ${Array.from(this.exporters.keys()).join(', ')}`);
    }
    return await exporter.export(model, outputPath);
  }
}
