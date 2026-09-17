import * as fs from 'fs/promises';
import * as path from 'path';
import { ICADExporter, CADRenderResult, CSGNode } from './UniversalCADEngine.js';

export class SVGExporter implements ICADExporter {
  public format = 'SVG';

  public async export(node: CSGNode, outputPath: string): Promise<CADRenderResult> {
    const svgElements: string[] = [];
    this.renderNodeToSVG(node, svgElements, 100, 100);

    const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <rect width="100%" height="100%" fill="#1a1a1a" />
  <g stroke="#00ffcc" stroke-width="2" fill="rgba(0, 255, 204, 0.15)" transform="translate(100, 100)">
    ${svgElements.join('\n    ')}
  </g>
</svg>`;

    const resolvedPath = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, svgContent, 'utf-8');

    return {
      format: this.format,
      outputFilePath: resolvedPath,
      rawContent: svgContent
    };
  }

  private renderNodeToSVG(node: CSGNode, elements: string[], cx: number, cy: number): void {
    if (node.type === 'CUBE' && node.dimensions) {
      const [w, h] = node.dimensions;
      elements.push(`<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="2" />`);
    } else if (node.type === 'CYLINDER' && node.dimensions) {
      const [r] = node.dimensions;
      elements.push(`<circle cx="0" cy="0" r="${r}" />`);
    } else if (node.children) {
      for (const child of node.children) {
        this.renderNodeToSVG(child, elements, cx, cy);
      }
    }
  }
}
