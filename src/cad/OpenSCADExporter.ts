import * as fs from 'fs/promises';
import { ICADExporter, CSGNode, GeometricPrimitive, CADRenderResult } from './UniversalCADEngine.js';

export class OpenSCADExporter implements ICADExporter {
  targetFormat = 'SCAD';

  compile(node: CSGNode | GeometricPrimitive): string {
    if ('type' in node) {
      if (node.type === 'CUBE') {
        return `cube([${node.dimensions.join(',')}], center=true);`;
      }
      if (node.type === 'CYLINDER') {
        return `cylinder(h=${node.dimensions[0]}, r=${node.dimensions[1]}, center=true);`;
      }
      if (node.type === 'SPHERE') {
        return `sphere(r=${node.dimensions[0]});`;
      }
    } else {
      const op = node.operation.toLowerCase();
      const childrenCode = node.children.map(c => this.compile(c)).join('\n  ');
      return `${op}() {\n  ${childrenCode}\n}`;
    }
    return '// Unknown geometry';
  }

  async exportArtifact(node: CSGNode | GeometricPrimitive, outputPath: string): Promise<CADRenderResult> {
    const scadCode = this.compile(node);
    await fs.writeFile(outputPath, scadCode, 'utf-8');
    return {
      format: 'SCAD',
      outputFilePath: outputPath,
      metadata: { codeLength: scadCode.length }
    };
  }
}
