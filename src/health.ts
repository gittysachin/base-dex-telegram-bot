import { supabase } from './supabase.js';
import { logger } from './logger.js';
import { config } from './config.js';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  services: {
    database: ServiceHealth;
    rpc: ServiceHealth;
    zeroX: ServiceHealth;
    alchemy: ServiceHealth;
  };
  uptime: number;
  version: string;
}

export interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTime?: number;
  error?: string;
  lastChecked: string;
}

const startTime = Date.now();

export async function checkHealth(): Promise<HealthStatus> {
  const timestamp = new Date().toISOString();
  const uptime = Date.now() - startTime;
  
  // Check all services in parallel
  const [database, rpc, zeroX, alchemy] = await Promise.allSettled([
    checkDatabase(),
    checkRPC(),
    checkZeroX(),
    checkAlchemy()
  ]);

  const services = {
    database: database.status === 'fulfilled' ? database.value : { status: 'unhealthy' as const, error: 'Database check failed', lastChecked: timestamp },
    rpc: rpc.status === 'fulfilled' ? rpc.value : { status: 'unhealthy' as const, error: 'RPC check failed', lastChecked: timestamp },
    zeroX: zeroX.status === 'fulfilled' ? zeroX.value : { status: 'unhealthy' as const, error: '0x API check failed', lastChecked: timestamp },
    alchemy: alchemy.status === 'fulfilled' ? alchemy.value : { status: 'unhealthy' as const, error: 'Alchemy API check failed', lastChecked: timestamp }
  };

  // Determine overall status
  const serviceStatuses = Object.values(services).map(s => s.status);
  let overallStatus: 'healthy' | 'degraded' | 'unhealthy';
  
  if (serviceStatuses.every(s => s === 'healthy')) {
    overallStatus = 'healthy';
  } else if (serviceStatuses.some(s => s === 'unhealthy')) {
    overallStatus = 'unhealthy';
  } else {
    overallStatus = 'degraded';
  }

  return {
    status: overallStatus,
    timestamp,
    services,
    uptime,
    version: process.env.npm_package_version || '1.0.0'
  };
}

async function checkDatabase(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const { error } = await supabase
      .from('users')
      .select('id')
      .limit(1);
    
    const responseTime = Date.now() - start;
    
    if (error) {
      logger.error({ error }, 'Database health check failed');
      return {
        status: 'unhealthy',
        responseTime,
        error: error.message,
        lastChecked: new Date().toISOString()
      };
    }
    
    return {
      status: 'healthy',
      responseTime,
      lastChecked: new Date().toISOString()
    };
  } catch (error) {
    const responseTime = Date.now() - start;
    logger.error({ error }, 'Database health check exception');
    return {
      status: 'unhealthy',
      responseTime,
      error: error instanceof Error ? error.message : 'Unknown error',
      lastChecked: new Date().toISOString()
    };
  }
}

async function checkRPC(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const provider = new (await import('ethers')).JsonRpcProvider(config.BASE_RPC_URL);
    const blockNumber = await provider.getBlockNumber();
    
    const responseTime = Date.now() - start;
    
    if (typeof blockNumber !== 'number' || blockNumber <= 0) {
      return {
        status: 'degraded',
        responseTime,
        error: 'Invalid block number received',
        lastChecked: new Date().toISOString()
      };
    }
    
    return {
      status: 'healthy',
      responseTime,
      lastChecked: new Date().toISOString()
    };
  } catch (error) {
    const responseTime = Date.now() - start;
    logger.error({ error }, 'RPC health check failed');
    return {
      status: 'unhealthy',
      responseTime,
      error: error instanceof Error ? error.message : 'Unknown error',
      lastChecked: new Date().toISOString()
    };
  }
}

async function checkZeroX(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    // Use a proper 0x API endpoint for health check - get quote for ETH to USDC
    const url = new URL(config.ZEROX_SWAP_BASE_URL);
    url.searchParams.set('sellToken', '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'); // ETH
    url.searchParams.set('buyToken', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'); // USDC on Base
    url.searchParams.set('sellAmount', '1000000000000000'); // 0.001 ETH
    url.searchParams.set('taker', '0xc69b04bDdD0Eb0aC83afe533fd173610C6c2f864'); // Example Taker address
    url.searchParams.set('chainId', String(config.BASE_CHAIN_ID));
    
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        ...(config.ZEROX_API_KEY ? { '0x-api-key': config.ZEROX_API_KEY } : {}),
        '0x-version': 'v2',
      },
    });

    const responseTime = Date.now() - start;
    
    if (!response.ok) {
      return {
        status: 'degraded',
        responseTime,
        error: `HTTP ${response.status}`,
        lastChecked: new Date().toISOString()
      };
    }
    
    // Check if we got a valid response with liquidity
    const data = await response.json();
    if (!data.liquidityAvailable) {
      return {
        status: 'degraded',
        responseTime,
        error: 'No liquidity available',
        lastChecked: new Date().toISOString()
      };
    }
    
    return {
      status: 'healthy',
      responseTime,
      lastChecked: new Date().toISOString()
    };
  } catch (error) {
    const responseTime = Date.now() - start;
    logger.error({ error }, '0x API health check failed');
    return {
      status: 'unhealthy',
      responseTime,
      error: error instanceof Error ? error.message : 'Unknown error',
      lastChecked: new Date().toISOString()
    };
  }
}

async function checkAlchemy(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const response = await fetch(config.ALCHEMY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
        id: 1,
      }),
    });
    
    const responseTime = Date.now() - start;
    
    if (!response.ok) {
      return {
        status: 'degraded',
        responseTime,
        error: `HTTP ${response.status}`,
        lastChecked: new Date().toISOString()
      };
    }
    
    const data = await response.json();
    if (data.error) {
      return {
        status: 'unhealthy',
        responseTime,
        error: data.error.message,
        lastChecked: new Date().toISOString()
      };
    }
    
    return {
      status: 'healthy',
      responseTime,
      lastChecked: new Date().toISOString()
    };
  } catch (error) {
    const responseTime = Date.now() - start;
    logger.error({ error }, 'Alchemy API health check failed');
    return {
      status: 'unhealthy',
      responseTime,
      error: error instanceof Error ? error.message : 'Unknown error',
      lastChecked: new Date().toISOString()
    };
  }
}

export function formatHealthStatus(health: HealthStatus): string {
  const statusEmoji = {
    healthy: '✅',
    degraded: '⚠️',
    unhealthy: '⚠️'
  };
  
  let message = `${statusEmoji[health.status]} **System Status: ${health.status.toUpperCase()}**\n\n`;
  message += `**Uptime**: ${Math.floor(health.uptime / 1000 / 60)} minutes\n`;
  message += `**Version**: ${health.version}\n`;
  message += `**Last Check**: ${new Date(health.timestamp).toLocaleString()}\n\n`;
  
  message += '**Services:**\n';
  for (const [service, status] of Object.entries(health.services)) {
    const emoji = statusEmoji[status.status];
    const responseTime = status.responseTime ? ` (${status.responseTime}ms)` : '';
    const error = status.error ? ` - ${status.error}` : '';
    message += `${emoji} ${service.toUpperCase()}: ${status.status}${responseTime}${error}\n`;
  }
  
  return message;
}
