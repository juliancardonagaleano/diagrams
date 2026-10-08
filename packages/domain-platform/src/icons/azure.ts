import type { IconPack } from './types';

/**
 * Glifos propios de los servicios de Azure: dibujos sencillos hechos para este proyecto que evocan lo que hace cada servicio.
 * NO son los logotipos oficiales de Microsoft, que son propietarios: quien tenga licencia para usarlos puede registrar un paquete
 * con ellos del proveedor `azure` y sustituirá a estos (ver docs/modulos/plataforma.md, «Iconografía de nubes»).
 */
export const azureIconPack: IconPack = {
  id: 'azure',
  name: 'Microsoft Azure',
  provider: 'azure',
  color: '#0078d4',
  aliases: ['microsoft azure', 'microsoft'],
  icons: {
    vm: {
      label: 'Virtual Machines',
      paths: ['M2 2.5h12V11H2z', 'M5.5 14h5 M8 11v3'],
      kinds: ['vm'],
      keywords: ['virtual machine', 'virtual machines', 'vm'],
    },
    aks: {
      label: 'Azure Kubernetes Service (AKS)',
      paths: ['M8 1.5l5.5 3.2v6.6L8 14.5l-5.5-3.2V4.7z', 'M8 5.6l2.3 4H5.7z'],
      kinds: ['cluster'],
      keywords: ['aks', 'kubernetes', 'k8s'],
    },
    'app-service': {
      label: 'App Service',
      paths: ['M1.5 2.5h13v11h-13z', 'M1.5 5.5h13', 'M3.5 4h.02 M5.5 4h.02', 'M4 8h8 M4 10.5h5'],
      kinds: ['cluster', 'other'],
      keywords: ['app service', 'appservice', 'web app', 'webapp'],
    },
    functions: {
      label: 'Azure Functions',
      paths: ['M9 1.5L4 9h3.5L7 14.5 12 7H8.5z'],
      kinds: ['other'],
      keywords: ['functions', 'azure functions'],
    },
    'blob-storage': {
      label: 'Blob Storage',
      paths: ['M2 2.5h12v3H2z M2 6.5h12v3H2z M2 10.5h12v3H2z', 'M4.5 4h.02 M4.5 8h.02 M4.5 12h.02'],
      kinds: ['storage'],
      keywords: ['blob', 'azure storage', 'storage account'],
    },
    'sql-database': {
      label: 'SQL Database',
      paths: ['M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2z', 'M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4', 'M3 8c0 1.1 2.2 2 5 2s5-.9 5-2'],
      kinds: ['database'],
      keywords: ['azure sql', 'sql database', 'sql server', 'sqlserver', 'mssql'],
    },
    'cosmos-db': {
      label: 'Cosmos DB',
      paths: ['M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z', 'M2 8h12', 'M8 2c-2.4 1.8-2.4 10.2 0 12 M8 2c2.4 1.8 2.4 10.2 0 12'],
      kinds: ['database'],
      keywords: ['cosmos', 'cosmosdb'],
    },
    'cache-redis': {
      label: 'Cache for Redis',
      paths: ['M2.5 2.5h11v11h-11z', 'M8.8 4.5L5.5 8.6h2.4l-.7 2.9 3.3-4.1H8.1z'],
      kinds: ['cache'],
      keywords: ['redis', 'azure cache', 'cache for redis'],
    },
    'service-bus': {
      label: 'Service Bus',
      paths: ['M2 4h12v8H2z', 'M2 4.6l6 4.4 6-4.4'],
      kinds: ['queue'],
      keywords: ['service bus', 'servicebus'],
    },
    'load-balancer': {
      label: 'Load Balancer',
      paths: ['M1.5 6.8h3v2.4h-3z', 'M4.5 8h3 M7.5 3.5v9', 'M7.5 3.5h2 M7.5 8h2 M7.5 12.5h2', 'M11.5 3.5h.02 M11.5 8h.02 M11.5 12.5h.02 M14 3.5h.02 M14 8h.02 M14 12.5h.02'],
      kinds: ['load-balancer'],
      keywords: ['load balancer'],
    },
    'application-gateway': {
      label: 'Application Gateway',
      paths: ['M1.5 6.8h3v2.4h-3z', 'M4.5 8h3 M7.5 3.5v9', 'M7.5 3.5h2 M7.5 8h2 M7.5 12.5h2', 'M9.5 2.4h5v2.2h-5z M9.5 6.9h5v2.2h-5z M9.5 11.4h5v2.2h-5z'],
      kinds: ['load-balancer', 'gateway'],
      keywords: ['application gateway', 'appgw', 'agw'],
    },
    'api-management': {
      label: 'API Management',
      paths: ['M1.5 2.5h13v11h-13z', 'M1.5 5.5h13', 'M6 7.6L4.4 9.2 6 10.8 M10 7.6l1.6 1.6L10 10.8'],
      kinds: ['gateway'],
      keywords: ['api management', 'apim'],
    },
    dns: {
      label: 'Azure DNS',
      paths: ['M8 1.5v13', 'M3 3.5h7.5l2 2-2 2H3z', 'M13 9H5.5l-2 2 2 2H13z'],
      kinds: ['dns'],
      keywords: ['dns', 'azure dns'],
    },
    'key-vault': {
      label: 'Key Vault',
      paths: ['M4 7h8v7H4z', 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2', 'M8 10v1.6'],
      kinds: ['secret-store'],
      keywords: ['key vault', 'keyvault'],
    },
    'container-registry': {
      label: 'Container Registry',
      paths: ['M8 1.5l5.5 3v7l-5.5 3-5.5-3v-7z', 'M2.5 4.5L8 7.5l5.5-3', 'M8 7.5v7'],
      kinds: ['registry'],
      keywords: ['acr', 'container registry'],
    },
    'virtual-network': {
      label: 'Virtual Network',
      paths: ['M8 5.5v2.4 M8 7.9L5.5 10 M8 7.9L10.5 10', 'M6.8 3.6h2.4v1.9H6.8z M4.3 10h2.4v1.9H4.3z M9.3 10h2.4v1.9H9.3z', 'M1.5 14.5h13'],
      kinds: ['network'],
      keywords: ['vnet', 'virtual network'],
    },
  },
};
