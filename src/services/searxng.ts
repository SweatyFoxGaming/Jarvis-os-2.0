import axios from 'axios';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function searchSearXNG(query: string, count: number = 5): Promise<SearchResult[]> {
  try {
    const response = await axios.get('http://localhost:8080/search', {
      params: {
        q: query,
        format: 'json',
      },
      timeout: 5000,
    });

    const results = response.data?.results || [];
    return results.slice(0, count).map((item: any) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.content || item.snippet || '',
    }));
  } catch (error) {
    console.error('[SearXNG Service Error]:', error);
    throw new Error('Failed to fetch search results from local SearXNG instance.');
  }
}