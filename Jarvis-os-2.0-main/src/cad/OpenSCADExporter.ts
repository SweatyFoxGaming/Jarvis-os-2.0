import * as fs from 'fs/promises';
import * as path from 'path';
import { ICADExporter, CSGNode, CADRenderResult } from './UniversalCADEngine.js';

export class OpenSCADExporter implements ICADExporter {
  public format = 'SCAD';

  public async export(node: CSGNode, outputPath: string): Promise<CADRenderResult> {
    const scadCode = this.compile(node);
    const resolvedPath = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, scadCode, 'utf-8');

    return {
      format: this.format,
      outputFilePath: resolvedPath,
      rawContent: scadCode
    };
  }

  private compile(node: CSGNode): string {
    if (node.type === 'CUBE' && node.dimensions) {
      return `cube([${node.dimensions.join(', ')}]);`;
    }
    if (node.type === 'CYLINDER' && node.dimensions) {
      return `cylinder(r=${node.dimensions[0]}, h=${node.dimensions[1] || 10});`;
    }
    if (node.children) {
      const op = (node.operation || 'UNION').toLowerCase();
      const childrenCode = node.children.map((c: CSGNode) => this.compile(c)).join('\n  ');
      return `${op}() {\n  ${childrenCode}\n}`;
    }
    return '// empty node';
  }
}
