import * as fs from 'fs/promises';
import * as path from 'path';
import { ICADExporter, CADRenderResult, CSGNode } from './UniversalCADEngine.js';

export class STLExporter implements ICADExporter {
  public format = 'STL';

  public async export(node: CSGNode, outputPath: string): Promise<CADRenderResult> {
    const triangles: string[] = [];
    this.generateMeshTriangles(node, triangles);

    const stlContent = `solid jarvis_cad_model
${triangles.join('\n')}
endsolid jarvis_cad_model`;

    const resolvedPath = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, stlContent, 'utf-8');

    return {
      format: this.format,
      outputFilePath: resolvedPath,
      rawContent: stlContent
    };
  }

  private generateMeshTriangles(node: CSGNode, triangles: string[]): void {
    if (node.type === 'CUBE' && node.dimensions) {
      const [x, y, z] = node.dimensions;
      // Front face box triangles
      triangles.push(`  facet normal 0 0 1
    outer loop
      vertex 0 0 ${z}
      vertex ${x} 0 ${z}
      vertex ${x} ${y} ${z}
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex 0 0 ${z}
      vertex ${x} ${y} ${z}
      vertex 0 ${y} ${z}
    endloop
  endfacet`);
    } else if (node.type === 'CYLINDER' && node.dimensions) {
      const [r, h] = node.dimensions;
      triangles.push(`  facet normal 0 0 1
    outer loop
      vertex 0 0 ${h}
      vertex ${r} 0 ${h}
      vertex 0 ${r} ${h}
    endloop
  endfacet`);
    }

    if (node.children) {
      for (const child of node.children) {
        this.generateMeshTriangles(child, triangles);
      }
    }
  }
}
